import { backoffDelay } from "./backoff.js";
import { CRC32_HEADER, crc32Of } from "./checksum.js";
import { abortFailure } from "./failures.js";
import type { Classifier } from "./classify.js";
import {
  MISSING_ETAG_MESSAGE,
  toErrorInfo,
  uploadError,
  wrap,
  type UploadError,
} from "./errors.js";
import { planParts, type PartState } from "./plan.js";
import type { Semaphore } from "./semaphore.js";
import { createPartUrls, type PartUrl, type PartUrls, type UrlMinter } from "./urls.js";
import type {
  ChecksumAlgorithm,
  CompletedPart,
  FileDescriptor,
  Platform,
  Transport,
  UploadErrorCode,
  UploadErrorInfo,
  UploadStatus,
  S3Limits,
  UploadTarget,
} from "./types.js";

/** What the controller most recently asked this Upload to do. */
type Intent = "run" | "pause" | "cancel";

export interface UploadState {
  id: string;
  file: File | null;
  descriptor: FileDescriptor;
  status: UploadStatus;
  parts: PartState[];
  key: string | null;
  uploadId: string | null;
  error: UploadErrorInfo | null;
  intent: Intent;
  /** Aborts everything in flight for the current run. */
  controller: AbortController | null;
  /** Durable reference to the file, where the browser could give one. */
  handle: unknown;
  /** Settled when the Parts are planned; 0 until then. Carried by the Record. */
  partSize: number;
  /**
   * The most bytes ever reported. A Retry re-sends bytes already counted, so
   * the Parts' own `loaded` can fall; this is what progress shows instead.
   */
  loaded: number;
  /**
   * Whether this Upload's Parts carry checksums. Fixed when it is first Opened
   * and carried by the Record: a multipart upload created with a checksum
   * algorithm must be finished with one, whatever the reviving page asks for.
   */
  checksum: ChecksumAlgorithm | undefined;
  /**
   * Sent as one plain PUT rather than as multipart. Decided once, when the
   * Parts are planned: a file that fits in one Part, with a Transport that can
   * sign a single PUT. Such an Upload has a key but no uploadId, nothing to
   * finalise, and no Record.
   */
  single: boolean;
}

export interface UploadSettings {
  /** "auto" when the caller did not pick one — see planParts. */
  partSize: number | "auto";
  limits: S3Limits;
  concurrency: number;
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  partTimeoutMs: number;
  waitWhileOffline: boolean;
  classify: Classifier;
  /** Parts signed ahead of the send, when the Transport can sign on demand. */
  urlWindow: number;
  checksum: ChecksumAlgorithm | undefined;
}

export interface UploadDeps {
  platform: Platform;
  transport: Transport;
  settings: UploadSettings;
  /** Shared across the Batch — this is what enforces the Connection Budget. */
  budget: Semaphore;
  onChange: (state: UploadState) => void;
  /** `id` is the library's Upload id throughout, never the provider's. */
  onPartLanded: (id: string, partNumber: number) => void;
  onRetrying: (id: string, partNumber: number, attempt: number, delayMs: number) => void;
  /**
   * Persist the Upload Record.
   *
   * "milestone" must be written; "progress" may be coalesced, since it only
   * ever adds a landed Part and losing the last few costs a Resume nothing but
   * re-sending them.
   */
  onRecord: (state: UploadState, occasion?: "milestone" | "progress") => Promise<void>;
}

export const describeFile = (file: File): FileDescriptor => ({
  name: file.name,
  size: file.size,
  type: file.type,
  lastModified: file.lastModified,
});

/**
 * The provider's identity for an Upload that has been Opened. Only called once
 * Opening has settled both halves; asserting here keeps the casts in one place.
 */
export const targetOf = (state: UploadState): UploadTarget => {
  if (state.key === null || state.uploadId === null) {
    throw uploadError("UNKNOWN", `Upload ${state.id} was used before it was Opened.`);
  }
  return { key: state.key, uploadId: state.uploadId };
};

/** The landed Parts, in the order finalising requires. */
export const completedParts = (parts: PartState[]): CompletedPart[] =>
  parts
    .filter((part) => part.status === "landed" && part.eTag !== null)
    .map((part) => ({
      partNumber: part.partNumber,
      eTag: part.eTag as string,
      ...(part.checksumCRC32 === null ? {} : { checksumCRC32: part.checksumCRC32 }),
    }))
    .sort((a, b) => a.partNumber - b.partNumber);

export const createUploadState = (id: string, file: File, handle: unknown = null): UploadState => ({
  id,
  file,
  descriptor: describeFile(file),
  status: "pending",
  parts: [],
  key: null,
  uploadId: null,
  error: null,
  intent: "run",
  controller: null,
  handle,
  partSize: 0,
  loaded: 0,
  checksum: undefined,
  single: false,
});

const ACTIVE: UploadStatus[] = ["opening", "uploading", "completing"];
/** Whether a run is under way at this status — the only time a speed means anything. */
export const isActiveStatus = (status: UploadStatus): boolean => ACTIVE.includes(status);
export const isActive = (state: UploadState): boolean => isActiveStatus(state.status);

/**
 * Bytes sent so far, as progress reports them: never less than before.
 * Raises the high-water mark as a side effect, so call it on every change.
 */
export const loadedSoFar = (state: UploadState): number => {
  const sent = state.parts.reduce((sum, part) => sum + part.loaded, 0);
  state.loaded = Math.min(Math.max(state.loaded, sent), state.descriptor.size);
  return state.loaded;
};

const TERMINAL: UploadStatus[] = ["succeeded", "cancelled"];
export const isTerminal = (state: UploadState): boolean => TERMINAL.includes(state.status);

/**
 * Whether a Resume would have anything to do.
 *
 * Deliberately not "some Part has not landed". An Upload whose every Part
 * landed but whose finalising failed still has work outstanding — it needs
 * finalising again — and treating it as finished would strand the object
 * unfinalised with no way back.
 *
 * Nor is it keyed on `status`. That clause cost more than it bought: an Upload
 * Paused before it ever ran has no planned Parts, so `resume()` used to accept
 * it, do nothing, and report success — while CONTEXT.md promises a Paused Upload
 * can be Resumed. And the Resume path had to fabricate a `failed` status with a
 * fictional error to get past it, which surfaced on the snapshot as a red banner
 * on an Upload that was fine.
 *
 * What is left: Pause is always takeable back up, a failure is takeable back up
 * once Parts exist to take up, and nothing else is. An Upload that never started
 * is not "resumable" — `start()` is its verb.
 */
export const isResumable = (state: UploadState): boolean => {
  if (isTerminal(state)) return false;
  // Pause is a decision to defer, never to discard, so it is always takeable
  // back up — including before any Part was planned.
  if (state.status === "paused") return true;
  // A failure at planning would fail identically on a Resume. Planned Parts are
  // what distinguish it from a failure while running.
  if (state.status === "failed") return state.parts.length > 0;
  return false;
};

const waitForOnline = (platform: Platform, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (platform.isOnline() || signal.aborted) {
      resolve();
      return;
    }
    const stop = platform.onOnline(() => {
      stop();
      resolve();
    });
    signal.addEventListener(
      "abort",
      () => {
        stop();
        resolve();
      },
      { once: true },
    );
  });

/**
 * Thrown to unwind a run that Pause or Cancel stopped.
 *
 * Not an UploadError: a halt is something the caller asked for, so it must
 * never reach a snapshot as an error or be mistaken for one by a Classifier.
 */
interface Halt {
  readonly halt: "pause" | "cancel";
}

const halted = (state: UploadState): Halt | null =>
  state.intent === "run" ? null : { halt: state.intent };

const throwIfHalted = (state: UploadState): void => {
  const stop = halted(state);
  if (stop) throw stop;
};

/** The browser has dropped off the network and the caller asked not to wait for it. */
const offlineFailure = (): UploadError =>
  uploadError("SEND_FAILED", "The browser is offline, and waitWhileOffline is off.");

/**
 * A request to the application's own API — Opening, signing a single PUT,
 * finalising — run the way a Part is: it waits out a disconnection without
 * spending anything, and a failure the Classifier rules transient is retried
 * with backoff. Fresh urls cannot help a failure here, hence alreadyRefreshed.
 */
const withRetries = async <T>(
  state: UploadState,
  deps: UploadDeps,
  request: () => Promise<T>,
): Promise<T> => {
  const { platform, settings } = deps;
  const signal = state.controller!.signal;
  let retriesSpent = 0;
  while (true) {
    if (!platform.isOnline()) {
      if (!settings.waitWhileOffline) throw offlineFailure();
      await waitForOnline(platform, signal);
    }
    throwIfHalted(state);
    try {
      return await request();
    } catch (error) {
      throwIfHalted(state);
      if (!platform.isOnline() && settings.waitWhileOffline) continue;
      const transient = settings.classify(error, { alreadyRefreshed: true }) === "retry";
      if (!transient || retriesSpent >= settings.maxRetries) throw error;
      await platform.sleep(
        backoffDelay(retriesSpent, settings.retryBaseMs, settings.retryMaxMs, platform.random),
        signal,
      );
      retriesSpent += 1;
    }
  }
};

/**
 * Open the Upload, or take up one that already exists.
 *
 * Returns the urls the Opening minted, if it minted any. A Transport that can
 * sign Parts on demand need not: Opening then settles only the identity of the
 * Upload, and the urls follow a window at a time.
 */
const openUpload = async (state: UploadState, deps: UploadDeps): Promise<string[]> => {
  const signal = state.controller!.signal;
  const resumeFrom =
    state.key !== null && state.uploadId !== null
      ? { key: state.key, uploadId: state.uploadId }
      : undefined;

  const opened = await deps.transport.open(state.descriptor, {
    partCount: state.parts.length,
    partSize: state.partSize,
    resumeFrom,
    checksumAlgorithm: state.checksum,
    signal,
  });

  const urls = opened.urls ?? [];

  // An Opening that signs nothing is only meaningful when something else can.
  if (urls.length === 0 && deps.transport.signParts === undefined) {
    throw uploadError(
      "URL_COUNT_MISMATCH",
      `Transport returned no urls for ${state.parts.length} Parts, and supplies no signParts to mint them.`,
    );
  }

  if (urls.length > 0 && urls.length !== state.parts.length) {
    throw uploadError(
      "URL_COUNT_MISMATCH",
      `Transport returned ${urls.length} urls for ${state.parts.length} Parts.`,
    );
  }

  if (
    resumeFrom !== undefined &&
    (opened.key !== resumeFrom.key || opened.uploadId !== resumeFrom.uploadId)
  ) {
    // Harvested ETags belong to the Upload they were sent to. Finalising a
    // different one splices Parts of two uploads, which no error downstream
    // would attribute to this.
    throw uploadError(
      "RESUME_MISMATCH",
      `Transport opened a second Upload (${opened.key}/${opened.uploadId}) when asked to take up ${resumeFrom.key}/${resumeFrom.uploadId}.`,
    );
  }

  state.key = opened.key;
  state.uploadId = opened.uploadId;
  // key and uploadId are both on the snapshot, so this must be visible.
  deps.onChange(state);

  return urls;
};

/**
 * Attribute a failed mid-flight Opening — a Refresh — to the open endpoint,
 * unless the Classifier rules it transient: then it must reach the Part's
 * retry loop as itself, exactly as the same failure from `signParts` does.
 */
const openingFailure = (error: unknown, settings: UploadSettings): unknown =>
  settings.classify(error, { alreadyRefreshed: true }) === "retry"
    ? error
    : wrap("TRANSPORT_OPEN_FAILED", "Opening the Upload failed", error);

/** The code for failing to obtain urls: whichever endpoint mints them for this Upload. */
const mintingFailureCode = (state: UploadState, deps: UploadDeps): UploadErrorCode =>
  state.single || deps.transport.signParts === undefined
    ? "TRANSPORT_OPEN_FAILED"
    : "TRANSPORT_SIGN_FAILED";

/**
 * The Part's CRC32, read from the file once and kept: a Retry or a Refresh
 * re-signs with the same value, and finalising needs it again.
 */
const checksumOf = async (
  state: UploadState,
  partNumber: number,
  signal: AbortSignal,
): Promise<string> => {
  const part = state.parts[partNumber - 1]!;
  if (part.checksumCRC32 === null) {
    part.checksumCRC32 = await crc32Of(state.file!.slice(part.start, part.end), signal);
  }
  return part.checksumCRC32;
};

/** Checksums for the named Parts, when they are on; read one at a time to bound memory. */
const checksumsFor = async (
  state: UploadState,
  partNumbers: number[],
  signal: AbortSignal,
): Promise<Record<number, string> | undefined> => {
  if (state.checksum === undefined) return undefined;
  const sums: Record<number, string> = {};
  for (const partNumber of partNumbers)
    sums[partNumber] = await checksumOf(state, partNumber, signal);
  return sums;
};

/**
 * The Presigned URL supply for one run.
 *
 * Three minters, one seam. A Transport that can sign named Parts mints a window
 * ahead and repairs an expiry by re-signing; one that cannot mints the whole
 * Upload at Opening and repairs an expiry by Opening again; a single PUT signs
 * its one url, and repairs an expiry by signing it again.
 */
const createUrlSupply = (state: UploadState, deps: UploadDeps, seed: string[]): PartUrls => {
  const { transport, settings } = deps;

  const signMinter: UrlMinter = async (partNumbers, signal) => {
    const minted = await transport.signParts!({
      ...targetOf(state),
      partNumbers,
      checksumsCRC32: await checksumsFor(state, partNumbers, signal),
      signal,
    });

    const missing = partNumbers.filter((partNumber) => minted[partNumber] === undefined);
    if (missing.length > 0) {
      throw uploadError(
        "URL_MISSING",
        `Transport signed no url for Part${missing.length > 1 ? "s" : ""} ${missing.join(", ")}.`,
      );
    }
    return minted;
  };

  const openMinter: UrlMinter = async () => {
    try {
      const urls = await openUpload(state, deps);
      return Object.fromEntries(urls.map((url, index) => [index + 1, url]));
    } catch (error) {
      // So a mid-flight Refresh reports the same cause as the Opening that
      // starts a run, rather than surfacing as a send failure.
      throw openingFailure(error, settings);
    }
  };

  const singleMinter: UrlMinter = async (_partNumbers, signal) => {
    try {
      const sums = await checksumsFor(state, [1], signal);
      const opened = await transport.openSingle!(state.descriptor, {
        checksumCRC32: sums?.[1],
        signal,
      });
      if (!opened?.key || !opened.url) {
        throw uploadError("TRANSPORT_OPEN_FAILED", "openSingle must return { key, url }.");
      }
      state.key = opened.key;
      deps.onChange(state);
      return { 1: opened.url };
    } catch (error) {
      throw openingFailure(error, settings);
    }
  };

  const signs = transport.signParts !== undefined;

  return createPartUrls({
    partCount: state.parts.length,
    mint: state.single ? singleMinter : signs ? signMinter : openMinter,
    windowSize: signs && !state.single ? Math.max(1, settings.urlWindow) : Number.POSITIVE_INFINITY,
    // One Refresh between landed Parts. A second failure on urls minted moments
    // ago is not an expiry, so re-Opening again would only loop.
    maxRefreshes: 1,
    seed,
  });
};

/**
 * What travels with a Part's bytes. Content-Type only matters to a single PUT,
 * but is harmless on a Part. The checksum must match the one signed into the
 * url, which is why it is computed before signing and never after.
 */
const partHeaders = (state: UploadState, part: PartState): Record<string, string> => {
  const headers: Record<string, string> = {};
  // Always the file's own type: a single PUT's url signs it, so it must match.
  if (state.descriptor.type) headers["Content-Type"] = state.descriptor.type;
  if (part.checksumCRC32 !== null) headers[CRC32_HEADER] = part.checksumCRC32;
  return headers;
};

const sendPartOnce = async (
  state: UploadState,
  part: PartState,
  deps: UploadDeps,
  url: string,
): Promise<string | null> => {
  const { platform, settings } = deps;

  part.status = "uploading";
  part.attempts += 1;
  part.loaded = 0;
  deps.onChange(state);

  const result = await platform.sendPart({
    url,
    body: state.file!.slice(part.start, part.end),
    id: state.id,
    partNumber: part.partNumber,
    headers: partHeaders(state, part),
    timeoutMs: settings.partTimeoutMs,
    signal: state.controller!.signal,
    onProgress: (loaded) => {
      const next = Math.min(loaded, part.size);
      // XHR reports progress far more often than any interface can use, and
      // each report costs a snapshot rebuild. Ignore movement below a percent
      // of the Part unless it is the Part finishing.
      if (next !== part.size && next - part.loaded < part.size / 100) return;
      part.loaded = next;
      deps.onChange(state);
    },
  });

  // Finalising needs every Part's ETag; a single PUT has nothing to finalise.
  if (result.eTag === null && !state.single)
    throw uploadError("MISSING_ETAG", MISSING_ETAG_MESSAGE);
  return result.eTag;
};

/** Send one Part, Retrying it while the failure looks worth repeating. */
const sendPartWithRetry = async (
  state: UploadState,
  part: PartState,
  deps: UploadDeps,
  urls: PartUrls,
): Promise<void> => {
  const { platform, settings } = deps;

  // Counted explicitly rather than by a loop variable, because parking while
  // offline and re-Opening for fresh urls both retry without spending the
  // budget. Decrementing a loop counter to express that was one slip away from
  // a loop that never ends.
  let retriesSpent = 0;

  const stopIfHalted = (): void => throwIfHalted(state);

  const parkPart = (): void => {
    part.status = "pending";
    part.loaded = 0;
    deps.onChange(state);
  };

  const failPart = (error: UploadError): never => {
    part.status = "failed";
    part.loaded = 0;
    // Announced before unwinding, or the Part reads as still uploading.
    deps.onChange(state);
    throw error;
  };

  while (true) {
    stopIfHalted();

    // Park before spending an Attempt. Time spent disconnected must not consume
    // the Retry budget, or a laptop asleep for an hour wakes with none left.
    if (!platform.isOnline()) {
      if (!settings.waitWhileOffline) failPart(offlineFailure());
      await waitForOnline(platform, state.controller!.signal);
      stopIfHalted();
    }

    // Null until obtained, so the catch can tell "the url was refused" from
    // "there was never a url" — a signing failure that no Refresh would fix.
    let url: PartUrl | null = null;

    // Taken per Attempt rather than for the whole retry loop. Held across the
    // backoff, a Part asleep for fifteen seconds occupies a connection it is
    // not using — and at the default Budget, five Parts backing off together
    // stalled every other Part in the Batch behind them.
    const signal = state.controller!.signal;
    const release = await deps.budget.acquire(state.id, signal);
    // Stopped in the instant the slot was handed over: give it straight back
    // rather than spend it. No Platform is trusted to check the signal itself.
    if (signal.aborted) {
      release();
      throw halted(state) ?? abortFailure("Stopped before the Part was sent");
    }
    let failure: unknown;

    try {
      // Taken inside the Attempt, so a failure is judged against the urls this
      // Attempt actually used rather than against whatever a sibling Part has
      // since refreshed to.
      url = await urls.get(part.partNumber, state.controller!.signal);
      part.eTag = await sendPartOnce(state, part, deps, url.value);
      part.status = "landed";
      part.loaded = part.size;
      // A landed Part proves the current urls work, so a later expiry may be
      // recovered from too. Without this, an upload long enough to outlive its
      // urls twice would die on the second expiry.
      urls.noteProgress(url.generation);
      deps.onChange(state);
      deps.onPartLanded(state.id, part.partNumber);
      await deps.onRecord(state, "progress");
      return;
    } catch (error) {
      failure = error;
    } finally {
      release();
    }

    {
      const error = failure;

      // The run was stopped — by Pause or Cancel, or because a sibling Part
      // failed and took the run down. Either way this Part did not fail; it was
      // interrupted, and must read as waiting rather than as uploading or failed.
      if (state.controller!.signal.aborted || halted(state) !== null) {
        parkPart();
        throw halted(state) ?? error;
      }

      // Losing the connection mid-Attempt is the same situation as being offline
      // beforehand: park and try again without spending the budget — or, with
      // waiting turned off, fail now rather than retry into a dead network.
      if (!platform.isOnline()) {
        if (!settings.waitWhileOffline) failPart(offlineFailure());
        parkPart();
        await waitForOnline(platform, state.controller!.signal);
        continue;
      }

      // A failure with no url in hand came from obtaining one. Fresh urls are
      // exactly what failed, so the classifier is told they have been tried —
      // which keeps a broken signing endpoint fatal and a flaky one Retryable.
      const verdict =
        url === null
          ? settings.classify(error, { alreadyRefreshed: true })
          : settings.classify(error, { alreadyRefreshed: !urls.canRefresh(url.generation) });

      if (verdict === "fatal") {
        // No url in hand means obtaining one failed: name the endpoint that mints them.
        failPart(
          wrap(
            url === null ? mintingFailureCode(state, deps) : "SEND_FAILED",
            `Part ${part.partNumber} failed`,
            error,
          ),
        );
      }

      // Fresh urls are a new situation, not another go at the old one, so this
      // costs no Retry. Whether there is a Refresh left to spend is the supply's
      // decision, not the classifier's — a replacement classifier that always
      // says "refresh" must not be able to loop the Core forever.
      if (verdict === "refresh" && url !== null) {
        const refreshed = await urls.refresh(url.generation);
        if (refreshed === null) {
          failPart(
            wrap(
              "SEND_FAILED",
              `Part ${part.partNumber} was refused on freshly minted urls`,
              error,
            ),
          );
        }
        parkPart();
        continue;
      }

      if (retriesSpent >= settings.maxRetries) {
        // Out of retries while obtaining a url: name the endpoint that kept
        // failing, as the same failure at the start of a run would.
        failPart(
          url === null
            ? wrap(
                mintingFailureCode(state, deps),
                `Part ${part.partNumber} could not get a url`,
                error,
              )
            : uploadError(
                "RETRIES_EXHAUSTED",
                `Part ${part.partNumber} failed after ${part.attempts} attempts: ${String(error)}`,
              ),
        );
      }

      const delayMs = backoffDelay(
        retriesSpent,
        settings.retryBaseMs,
        settings.retryMaxMs,
        platform.random,
      );
      retriesSpent += 1;
      deps.onRetrying(state.id, part.partNumber, part.attempts, delayMs);
      parkPart();
      await platform.sleep(delayMs, state.controller!.signal);
      // A Pause or Cancel that arrived during the sleep must settle as one.
      // Checked here rather than relying on the Platform, whose sleep may either
      // resolve early or reject on abort — a rejection inside the catch block
      // would have escaped the loop entirely and settled a Pause as a failure.
      stopIfHalted();
    }
  }
};

/**
 * Drive one Upload to a terminal or resumable state.
 *
 * Never throws: a failure is recorded on the Upload so one bad file in a Batch
 * cannot take its siblings down with it.
 */
export const runUpload = async (state: UploadState, deps: UploadDeps): Promise<void> => {
  const { settings } = deps;

  if (state.file === null) {
    state.status = "failed";
    state.error = { code: "FILE_REQUIRED", message: "The file's bytes are not available." };
    deps.onChange(state);
    return;
  }

  state.intent = "run";
  state.error = null;
  state.controller = new AbortController();

  /**
   * End the run. The intent decides before the error does: anything that fails
   * after a Pause or Cancel was asked for failed because of it — an aborted
   * request, an aborted sleep — and reporting it as a failure would turn the
   * caller's own decision into a red banner and skip Cancel's teardown.
   */
  const settle = (error: unknown): void => {
    const stop = halted(state);
    if (stop) {
      state.status = stop.halt === "cancel" ? "cancelled" : "paused";
      state.error = null;
    } else {
      state.status = "failed";
      state.error = toErrorInfo(error);
    }
    deps.onChange(state);
  };

  // A first run plans Parts; a Resume keeps the plan, and the Parts that landed.
  if (state.parts.length === 0) {
    try {
      const plan = planParts({
        size: state.descriptor.size,
        partSize: settings.partSize,
        ...settings.limits,
      });
      state.partSize = plan.partSize;
      state.parts = plan.parts;
      state.single = deps.transport.openSingle !== undefined && plan.parts.length === 1;
      state.checksum = settings.checksum;
    } catch (error) {
      settle(error);
      return;
    }
  } else {
    // Resume starts each unfinished Part with a fresh Retry budget.
    for (const part of state.parts) {
      if (part.status !== "landed") {
        part.attempts = 0;
        part.status = "pending";
        part.loaded = 0;
      }
    }
  }

  state.status = "opening";
  deps.onChange(state);

  let urls: PartUrls;
  try {
    if (state.single) {
      // Signing the one url is this Upload's whole Opening.
      const supply = createUrlSupply(state, deps, []);
      await withRetries(state, deps, () => supply.get(1, state.controller!.signal));
      urls = supply;
    } else {
      urls = createUrlSupply(
        state,
        deps,
        await withRetries(state, deps, () => openUpload(state, deps)),
      );
    }
  } catch (error) {
    settle(wrap("TRANSPORT_OPEN_FAILED", "Opening the Upload failed", error));
    return;
  }

  if (halted(state)) {
    settle(null);
    return;
  }

  state.status = "uploading";
  deps.onChange(state);
  await deps.onRecord(state);

  const outstanding = state.parts.filter((part) => part.status !== "landed");
  const failures: unknown[] = [];

  await Promise.all(
    outstanding.map(async (part) => {
      try {
        if (failures.length > 0 || halted(state)) return;
        // The Connection Budget is one queue shared across the whole Batch —
        // the browser's cap is per host, so that is where the limit belongs.
        // It is acquired per Attempt inside, not held for the whole retry loop.
        await sendPartWithRetry(state, part, deps, urls);
      } catch (error) {
        failures.push(error);
        // One doomed Part ends the run; the others stop rather than burn
        // bandwidth on an Upload that is already going to need a Resume.
        state.controller?.abort();
      }
    }),
  );

  if (failures.length > 0) {
    settle(failures[0]);
    await deps.onRecord(state);
    return;
  }

  if (halted(state)) {
    settle(null);
    return;
  }

  // A single PUT is finished the moment it lands.
  if (state.single) {
    state.status = "succeeded";
    deps.onChange(state);
    return;
  }

  state.status = "completing";
  deps.onChange(state);

  try {
    await withRetries(state, deps, () =>
      deps.transport.complete({ ...targetOf(state), parts: completedParts(state.parts) }),
    );
  } catch (error) {
    settle(wrap("TRANSPORT_COMPLETE_FAILED", "Finalising the Upload failed", error));
    return;
  }

  state.status = "succeeded";
  deps.onChange(state);
};
