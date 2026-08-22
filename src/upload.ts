import { backoffDelay } from "./backoff.js";
import type { Classifier } from "./classify.js";
import { MISSING_ETAG_MESSAGE, UploadError, toErrorInfo, uploadError } from "./errors.js";
import { planParts } from "./plan.js";
import { partConcurrencyFor, type Semaphore, createSemaphore } from "./semaphore.js";
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
  urls: string[];
  key: string | null;
  uploadId: string | null;
  error: UploadErrorInfo | null;
  intent: Intent;
  /** Aborts everything in flight for the current run. */
  controller: AbortController | null;
  /** True once this run has re-Opened for fresh urls after a 403. */
  reopened: boolean;
  /** Durable reference to the file, where the browser could give one. */
  handle: unknown | null;
}

export interface UploadSettings {
  partSize: number;
  minPartSize: number;
  maxParts: number;
  concurrency: number;
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  partTimeoutMs: number;
  waitWhileOffline: boolean;
  contentType: string | undefined;
  classify: Classifier;
}

export interface UploadDeps {
  platform: Platform;
  transport: Transport;
  settings: UploadSettings;
  /** Shared across the Batch — this is what enforces the Connection Budget. */
  budget: Semaphore;
  activeUploads: () => number;
  onChange: () => void;
  onPartLanded: (uploadId: string, partNumber: number) => void;
  onRetrying: (uploadId: string, partNumber: number, attempt: number, delayMs: number) => void;
  onRecord: (state: UploadState) => Promise<void>;
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
  urls: [],
  key: null,
  uploadId: null,
  error: null,
  intent: "run",
  controller: null,
  reopened: false,
  handle,
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
 * Both occasions yield a fresh set of Presigned URLs, because urls minted for an
 * earlier occasion may no longer be honoured by the time they are used.
 */
const openUpload = async (state: UploadState, deps: UploadDeps): Promise<void> => {
  const signal = state.controller!.signal;
  const resumeFrom =
    state.key !== null && state.uploadId !== null
      ? { key: state.key, uploadId: state.uploadId }
      : undefined;

  const opened = await deps.transport.open(state.descriptor, {
    partCount: state.parts.length,
    partSize: deps.settings.partSize,
    resumeFrom,
    signal,
  });

  if (opened.urls.length !== state.parts.length) {
    throw uploadError(
      "URL_COUNT_MISMATCH",
      `Transport returned ${opened.urls.length} urls for ${state.parts.length} Parts.`,
    );
  }

  state.key = opened.key;
  state.uploadId = opened.uploadId;
  state.urls = opened.urls;
};

const sendPartOnce = async (
  state: UploadState,
  part: PartSnapshot,
  deps: UploadDeps,
): Promise<string> => {
  const { platform, settings } = deps;
  const url = state.urls[part.partNumber - 1]!;

  part.status = "uploading";
  part.attempts += 1;
  part.loaded = 0;
  deps.onChange();

  const result = await platform.sendPart({
    url,
    body: state.file!.slice(part.start, part.end),
    uploadId: state.id,
    partNumber: part.partNumber,
    contentType: settings.contentType ?? state.descriptor.type,
    timeoutMs: settings.partTimeoutMs,
    signal: state.controller!.signal,
    onProgress: (loaded) => {
      part.loaded = Math.min(loaded, part.size);
      deps.onChange();
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
): Promise<void> => {
  const { platform, settings } = deps;

  for (let retry = 0; ; retry += 1) {
    const stopped = halted(state);
    if (stopped) throw stopped;

    // Park before spending an Attempt. Time spent disconnected must not consume
    // the Retry budget, or a laptop asleep for an hour wakes with none left.
    if (settings.waitWhileOffline && !platform.isOnline()) {
      await waitForOnline(platform, state.controller!.signal);
      const stoppedAfterWait = halted(state);
      if (stoppedAfterWait) throw stoppedAfterWait;
    }

    try {
      part.eTag = await sendPartOnce(state, part, deps);
      part.status = "landed";
      part.loaded = part.size;
      // Progress since the last re-Open means the fresh urls worked, so a later
      // expiry may be recovered from too. Without this, an upload long enough to
      // outlive its urls twice would die on the second expiry. A genuine
      // authorisation failure still terminates, because it 403s again straight
      // away with nothing landing in between.
      state.reopened = false;
      deps.onChange();
      deps.onPartLanded(state.id, part.partNumber);
      await deps.onRecord(state);
      return;
    } catch (error) {
      const stoppedNow = halted(state);
      if (stoppedNow) throw stoppedNow;

      // Losing the connection mid-Attempt is the same situation as being offline
      // beforehand: park and try again without spending the budget.
      if (settings.waitWhileOffline && !platform.isOnline()) {
        part.status = "pending";
        part.loaded = 0;
        deps.onChange();
        await waitForOnline(platform, state.controller!.signal);
        retry -= 1;
        continue;
      }

      const verdict = settings.classify(error, { alreadyReopened: state.reopened });

      if (verdict === "fatal") {
        part.status = "failed";
        part.loaded = 0;
        throw error instanceof UploadError
          ? error
          : uploadError("SEND_FAILED", `Part ${part.partNumber} failed: ${String(error)}`);
      }

      if (verdict === "reopen") {
        state.reopened = true;
        await openUpload(state, deps);
        retry -= 1;
        continue;
      }

      if (retry >= settings.maxRetries) {
        part.status = "failed";
        part.loaded = 0;
        throw uploadError(
          "RETRIES_EXHAUSTED",
          `Part ${part.partNumber} failed after ${part.attempts} attempts: ${String(error)}`,
        );
      }

      const delayMs = backoffDelay(retry, settings.retryBaseMs, settings.retryMaxMs, platform.random);
      deps.onRetrying(state.id, part.partNumber, part.attempts, delayMs);
      part.status = "pending";
      part.loaded = 0;
      deps.onChange();
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
    deps.onChange();
    return;
  }

  state.intent = "run";
  state.reopened = false;
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
    deps.onChange();
  };

  // A first run plans Parts; a Resume keeps the plan, and the Parts that landed.
  if (state.parts.length === 0) {
    try {
      state.parts = planParts({
        size: state.descriptor.size,
        partSize: settings.partSize,
        minPartSize: settings.minPartSize,
        maxParts: settings.maxParts,
      });
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
  deps.onChange();

  try {
    await openUpload(state, deps);
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
  deps.onChange();
  await deps.onRecord(state);

  // Each Upload takes a share of the Batch-wide budget, so many files cannot
  // together exceed the browser's per-host connection cap.
  const share = createSemaphore(
    Math.min(deps.budget.limit, partConcurrencyFor(deps.activeUploads(), deps.budget.limit)),
  );

  const outstanding = state.parts.filter((part) => part.status !== "landed");
  const failures: unknown[] = [];

  await Promise.all(
    outstanding.map(async (part) => {
      const releaseShare = await share.acquire();
      const releaseBudget = await deps.budget.acquire();
      try {
        if (failures.length > 0 || halted(state)) return;
        await sendPartWithRetry(state, part, deps);
      } catch (error) {
        failures.push(error);
        // One doomed Part ends the run; the others stop rather than burn
        // bandwidth on an Upload that is already going to need a Resume.
        state.controller?.abort();
      } finally {
        releaseBudget();
        releaseShare();
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
  deps.onChange();

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
  deps.onChange();
};
