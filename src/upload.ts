import { backoffDelay } from "./backoff.js";
import type { Classifier } from "./classify.js";
import { MISSING_ETAG_MESSAGE, UploadError, toErrorInfo, uploadError } from "./errors.js";
import { planParts } from "./plan.js";
import type { Semaphore } from "./semaphore.js";
import { createPartUrls, type PartUrl, type PartUrls, type UrlMinter } from "./urls.js";
import type {
  CompletedPart,
  FileDescriptor,
  PartSnapshot,
  Platform,
  Transport,
  UploadErrorInfo,
  UploadStatus,
} from "./types.js";

/** What the controller most recently asked this Upload to do. */
export type Intent = "run" | "pause" | "cancel";

export interface UploadState {
  id: string;
  file: File | null;
  descriptor: FileDescriptor;
  status: UploadStatus;
  parts: PartSnapshot[];
  key: string | null;
  uploadId: string | null;
  error: UploadErrorInfo | null;
  intent: Intent;
  /** Aborts everything in flight for the current run. */
  controller: AbortController | null;
  /** Durable reference to the file, where the browser could give one. */
  handle: unknown | null;
  /** Bumped on every mutation, so a snapshot can be reused until it changes. */
  version: number;
  /** Settled when the Parts are planned; 0 until then. Carried by the Record. */
  partSize: number;
}

export interface UploadSettings {
  /** "auto" when the caller did not pick one — see planParts. */
  partSize: number | "auto";
  minPartSize: number;
  maxParts: number;
  maxPartSize: number;
  maxObjectSize: number;
  concurrency: number;
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  partTimeoutMs: number;
  waitWhileOffline: boolean;
  contentType: string | undefined;
  classify: Classifier;
  /** Parts signed ahead of the send, when the Transport can sign on demand. */
  urlWindow: number;
}

export interface UploadDeps {
  platform: Platform;
  transport: Transport;
  settings: UploadSettings;
  /** Shared across the Batch — this is what enforces the Connection Budget. */
  budget: Semaphore;
  onChange: (state: UploadState) => void;
  onPartLanded: (uploadId: string, partNumber: number) => void;
  onRetrying: (uploadId: string, partNumber: number, attempt: number, delayMs: number) => void;
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

export const createUploadState = (
  id: string,
  file: File,
  handle: unknown = null,
): UploadState => ({
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
  version: 0,
  partSize: 0,
});

/**
 * Whether a Resume would have anything to do.
 *
 * Deliberately not "some Part has not landed". An Upload whose every Part
 * landed but whose finalising failed still has work outstanding — it needs
 * finalising again — and treating it as finished would strand the object
 * unfinalised with no way back.
 *
 * Parts being planned at all is the real test: an Upload rejected before
 * planning (an empty file, too many Parts) would fail identically on a Resume,
 * so it is not resumable.
 */
export const isResumable = (state: UploadState): boolean =>
  (state.status === "failed" || state.status === "paused") && state.parts.length > 0;

const TERMINAL: UploadStatus[] = ["succeeded", "cancelled"];
export const isTerminal = (state: UploadState): boolean => TERMINAL.includes(state.status);

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

const halted = (state: UploadState): UploadError | null => {
  if (state.intent === "cancel") return uploadError("CANCELLED", "The Upload was cancelled.");
  if (state.intent === "pause") return uploadError("PAUSED", "The Upload was paused.");
  return null;
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

  if (resumeFrom !== undefined && (opened.key !== resumeFrom.key || opened.uploadId !== resumeFrom.uploadId)) {
    // Harvested ETags belong to the Upload they were sent to. Finalising a
    // different one splices Parts of two uploads, which no error downstream
    // would attribute to this.
    throw uploadError(
      "URL_COUNT_MISMATCH",
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
 * The Presigned URL supply for one run.
 *
 * Two minters sit behind one seam. Where the Transport can sign named Parts,
 * urls are minted a window ahead and an expiry is repaired by re-signing what
 * is in flight. Where it cannot, the whole Upload is minted by an Opening and an
 * expiry is repaired by Opening again — the original behaviour, now sequenced so
 * that Parts meeting one expiry together share one Opening between them.
 */
const createUrlSupply = (state: UploadState, deps: UploadDeps, seed: string[]): PartUrls => {
  const { transport, settings } = deps;

  const signMinter: UrlMinter = async (partNumbers, signal) => {
    const minted = await transport.signParts!({
      key: state.key as string,
      uploadId: state.uploadId as string,
      partNumbers,
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
    const urls = await openUpload(state, deps);
    return Object.fromEntries(urls.map((url, index) => [index + 1, url]));
  };

  const signs = transport.signParts !== undefined;

  return createPartUrls({
    partCount: state.parts.length,
    mint: signs ? signMinter : openMinter,
    windowSize: signs ? Math.max(1, settings.urlWindow) : Number.POSITIVE_INFINITY,
    // One Refresh between landed Parts. A second failure on urls minted moments
    // ago is not an expiry, so re-Opening again would only loop.
    maxRefreshes: 1,
    seed,
  });
};

const sendPartOnce = async (
  state: UploadState,
  part: PartSnapshot,
  deps: UploadDeps,
  url: string,
): Promise<string> => {
  const { platform, settings } = deps;

  part.status = "uploading";
  part.attempts += 1;
  part.loaded = 0;
  deps.onChange(state);

  const result = await platform.sendPart({
    url,
    body: state.file!.slice(part.start, part.end),
    uploadId: state.id,
    partNumber: part.partNumber,
    contentType: settings.contentType ?? state.descriptor.type,
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

  if (result.eTag === null) throw uploadError("MISSING_ETAG", MISSING_ETAG_MESSAGE);
  return result.eTag;
};

/** Send one Part, Retrying it while the failure looks worth repeating. */
const sendPartWithRetry = async (
  state: UploadState,
  part: PartSnapshot,
  deps: UploadDeps,
  urls: PartUrls,
): Promise<void> => {
  const { platform, settings } = deps;

  // Counted explicitly rather than by a loop variable, because parking while
  // offline and re-Opening for fresh urls both retry without spending the
  // budget. Decrementing a loop counter to express that was one slip away from
  // a loop that never ends.
  let retriesSpent = 0;

  const stopIfHalted = (): void => {
    const stopped = halted(state);
    if (stopped) throw stopped;
  };

  const parkPart = (): void => {
    part.status = "pending";
    part.loaded = 0;
    deps.onChange(state);
  };

  const failPart = (error: UploadError): never => {
    part.status = "failed";
    part.loaded = 0;
    throw error;
  };

  while (true) {
    stopIfHalted();

    // Park before spending an Attempt. Time spent disconnected must not consume
    // the Retry budget, or a laptop asleep for an hour wakes with none left.
    if (settings.waitWhileOffline && !platform.isOnline()) {
      await waitForOnline(platform, state.controller!.signal);
      stopIfHalted();
    }

    // Null until obtained, so the catch can tell "the url was refused" from
    // "there was never a url" — a signing failure that no Refresh would fix.
    let url: PartUrl | null = null;

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
      stopIfHalted();

      // Losing the connection mid-Attempt is the same situation as being offline
      // beforehand: park and try again without spending the budget.
      if (settings.waitWhileOffline && !platform.isOnline()) {
        parkPart();
        await waitForOnline(platform, state.controller!.signal);
        continue;
      }

      // A failure with no url in hand came from obtaining one. Fresh urls are
      // exactly what failed, so the classifier is told they have been tried —
      // which keeps a broken signing endpoint fatal and a flaky one Retryable.
      const verdict =
        url === null
          ? settings.classify(error, { alreadyReopened: true })
          : settings.classify(error, { alreadyReopened: !urls.canRefresh(url.generation) });

      if (verdict === "fatal") {
        failPart(
          error instanceof UploadError
            ? error
            : uploadError("SEND_FAILED", `Part ${part.partNumber} failed: ${String(error)}`),
        );
      }

      // Fresh urls are a new situation, not another go at the old one, so this
      // costs no Retry. Whether there is a Refresh left to spend is the supply's
      // decision, not the classifier's — a replacement classifier that always
      // says "reopen" must not be able to loop the Core forever.
      if (verdict === "reopen" && url !== null) {
        const refreshed = await urls.refresh(url.generation, state.controller!.signal);
        if (refreshed === null) {
          failPart(
            error instanceof UploadError
              ? error
              : uploadError(
                  "SEND_FAILED",
                  `Part ${part.partNumber} was refused on freshly minted urls: ${String(error)}`,
                ),
          );
        }
        parkPart();
        continue;
      }

      if (retriesSpent >= settings.maxRetries) {
        failPart(
          uploadError(
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

  const settle = (error: unknown): void => {
    const info = toErrorInfo(error);
    if (info.code === "CANCELLED") {
      state.status = "cancelled";
      state.error = null;
    } else if (info.code === "PAUSED") {
      state.status = "paused";
      state.error = null;
    } else {
      state.status = "failed";
      state.error = info;
    }
    deps.onChange(state);
  };

  // A first run plans Parts; a Resume keeps the plan, and the Parts that landed.
  if (state.parts.length === 0) {
    try {
      const plan = planParts({
        size: state.descriptor.size,
        partSize: settings.partSize,
        minPartSize: settings.minPartSize,
        maxParts: settings.maxParts,
        maxPartSize: settings.maxPartSize,
        maxObjectSize: settings.maxObjectSize,
      });
      state.partSize = plan.partSize;
      state.parts = plan.parts;
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
    urls = createUrlSupply(state, deps, await openUpload(state, deps));
  } catch (error) {
    settle(
      error instanceof UploadError
        ? error
        : uploadError("TRANSPORT_OPEN_FAILED", `Opening the Upload failed: ${String(error)}`),
    );
    return;
  }

  const stoppedAfterOpen = halted(state);
  if (stoppedAfterOpen) {
    settle(stoppedAfterOpen);
    return;
  }

  state.status = "uploading";
  deps.onChange(state);
  await deps.onRecord(state);

  const outstanding = state.parts.filter((part) => part.status !== "landed");
  const failures: unknown[] = [];

  await Promise.all(
    outstanding.map(async (part) => {
      // One queue, shared across the whole Batch. The browser's cap is per
      // host, so that is where the limit belongs; a second per-Upload queue on
      // top only added an await and a fairness rule the FIFO already gives.
      const release = await deps.budget.acquire();
      try {
        if (failures.length > 0 || halted(state)) return;
        await sendPartWithRetry(state, part, deps, urls);
      } catch (error) {
        failures.push(error);
        // One doomed Part ends the run; the others stop rather than burn
        // bandwidth on an Upload that is already going to need a Resume.
        state.controller?.abort();
      } finally {
        release();
      }
    }),
  );

  if (failures.length > 0) {
    settle(failures[0]);
    await deps.onRecord(state);
    return;
  }

  const stoppedBeforeComplete = halted(state);
  if (stoppedBeforeComplete) {
    settle(stoppedBeforeComplete);
    return;
  }

  state.status = "completing";
  deps.onChange(state);

  const parts: CompletedPart[] = state.parts
    .filter((part) => part.eTag !== null)
    .map((part) => ({ partNumber: part.partNumber, eTag: part.eTag as string }))
    .sort((a, b) => a.partNumber - b.partNumber);

  try {
    await deps.transport.complete({
      key: state.key as string,
      uploadId: state.uploadId as string,
      parts,
    });
  } catch (error) {
    settle(uploadError("TRANSPORT_COMPLETE_FAILED", `Finalising the Upload failed: ${String(error)}`));
    return;
  }

  state.status = "succeeded";
  deps.onChange(state);
};
