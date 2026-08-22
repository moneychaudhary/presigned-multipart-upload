import { defaultClassifier } from "./classify.js";
import { uploadError } from "./errors.js";
import { createObservable } from "./observable.js";
import { browserPlatform } from "./platform/browser.js";
import { createSemaphore } from "./semaphore.js";
import { DEFAULT_RECORD_TTL_MS, type UploadRecord } from "./store.js";
import type {
  BatchController,
  BatchFile,
  BatchOptions,
  BatchSnapshot,
  BatchStatus,
  PartSnapshot,
  Progress,
  UploadSnapshot,
} from "./types.js";
import {
  createUploadState,
  isResumable,
  isTerminal,
  runUpload,
  type UploadDeps,
  type UploadSettings,
  type UploadState,
} from "./upload.js";

const MIB = 1024 * 1024;

const DEFAULTS = {
  partSize: 10 * MIB,
  minPartSize: 5 * MIB,
  maxParts: 10_000,
  concurrency: 5,
  maxRetries: 3,
  retryBaseMs: 500,
  retryMaxMs: 15_000,
  partTimeoutMs: 0,
  waitWhileOffline: true,
} as const;

const percentOf = (loaded: number, total: number): number =>
  total === 0 ? 0 : Math.round((loaded / total) * 10_000) / 100;

const progressOf = (loaded: number, total: number): Progress =>
  Object.freeze({ loaded, total, percent: percentOf(loaded, total) });

const snapshotUpload = (state: UploadState): UploadSnapshot => {
  const total = state.descriptor.size;
  const loaded = state.parts.reduce((sum, part) => sum + part.loaded, 0);
  return Object.freeze({
    id: state.id,
    file: state.descriptor,
    status: state.status,
    progress: progressOf(Math.min(loaded, total), total),
    // Copied so a retained snapshot does not mutate underneath its holder, but
    // not frozen: freezing every Part on every change was the single most
    // expensive thing the library did, and `readonly` already says it.
    parts: state.parts.map((part) => ({ ...part })),
    key: state.key,
    uploadId: state.uploadId,
    error: state.error,
    resumable: isResumable(state),
  });
};

/**
 * A Batch's status derives from its Uploads rather than being tracked
 * separately, so the two can never disagree. Precedence, not uniformity: a
 * mixed terminal set must never report success just because it is not uniformly
 * anything else.
 */
const deriveBatchStatus = (uploads: UploadSnapshot[]): BatchStatus => {
  if (uploads.length === 0) return "idle";
  if (uploads.every((upload) => upload.status === "pending")) return "idle";

  const active = uploads.some((upload) =>
    ["opening", "uploading", "completing"].includes(upload.status),
  );
  if (active) return "uploading";

  if (uploads.some((upload) => upload.status === "failed")) return "failed";
  if (uploads.some((upload) => upload.status === "paused")) return "paused";
  if (uploads.some((upload) => upload.status === "cancelled")) return "cancelled";
  if (uploads.some((upload) => upload.status === "pending")) return "uploading";
  return "succeeded";
};

const toRecord = (state: UploadState, partSize: number, now: number): UploadRecord => ({
  id: state.id,
  key: state.key as string,
  uploadId: state.uploadId as string,
  file: state.descriptor,
  partSize,
  partCount: state.parts.length,
  landed: state.parts
    .filter((part) => part.status === "landed" && part.eTag !== null)
    .map((part) => ({ partNumber: part.partNumber, eTag: part.eTag as string })),
  updatedAt: now,
  handle: state.handle,
});

const toInput = (entry: BatchFile): { file: File; handle: unknown } =>
  entry instanceof File ? { file: entry, handle: null } : { file: entry.file, handle: entry.handle ?? null };

export interface BatchInternalOptions extends BatchOptions {
  /** Pre-built states, used when taking up Uploads recovered from the store. */
  seed?: UploadState[];
}

export const createBatch = (options: BatchInternalOptions): BatchController => {
  const platform = options.platform ?? browserPlatform();
  const store = options.store ?? null;
  const recordTtlMs = options.recordTtlMs ?? DEFAULT_RECORD_TTL_MS;

  const settings: UploadSettings = {
    partSize: options.partSize ?? DEFAULTS.partSize,
    minPartSize: options.minPartSize ?? DEFAULTS.minPartSize,
    maxParts: options.maxParts ?? DEFAULTS.maxParts,
    concurrency: options.concurrency ?? DEFAULTS.concurrency,
    maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
    retryBaseMs: options.retryBaseMs ?? DEFAULTS.retryBaseMs,
    retryMaxMs: options.retryMaxMs ?? DEFAULTS.retryMaxMs,
    partTimeoutMs: options.partTimeoutMs ?? DEFAULTS.partTimeoutMs,
    waitWhileOffline: options.waitWhileOffline ?? DEFAULTS.waitWhileOffline,
    contentType: options.contentType,
    classify: options.classify ?? defaultClassifier,
  };

  const states: UploadState[] =
    options.seed ??
    options.files.map((entry, index) => {
      const { file, handle } = toInput(entry);
      return createUploadState(`upload-${index + 1}`, file, handle);
    });

  const budget = createSemaphore(settings.concurrency);
  const running = new Map<string, Promise<void>>();
  const tornDown = new Set<string>();

  // An Upload's snapshot is rebuilt only when that Upload changed. Without this
  // a progress tick on one file re-copied the Parts of every file in the Batch.
  const cache = new Map<string, { version: number; snapshot: UploadSnapshot }>();

  const cachedSnapshot = (state: UploadState): UploadSnapshot => {
    const hit = cache.get(state.id);
    if (hit !== undefined && hit.version === state.version) return hit.snapshot;
    const snapshot = snapshotUpload(state);
    cache.set(state.id, { version: state.version, snapshot });
    return snapshot;
  };

  const buildSnapshot = (): BatchSnapshot => {
    const uploads = states.map(cachedSnapshot);
    const total = uploads.reduce((sum, upload) => sum + upload.progress.total, 0);
    const loaded = uploads.reduce((sum, upload) => sum + upload.progress.loaded, 0);
    return Object.freeze({
      status: deriveBatchStatus(uploads),
      progress: progressOf(loaded, total),
      uploads: Object.freeze(uploads) as UploadSnapshot[],
    });
  };

  const observable = createObservable(buildSnapshot);

  /**
   * Record that an Upload changed. The per-Upload snapshot cache is keyed on
   * `version`, so every mutation must come through here — bumping the version
   * anywhere else, or invalidating without bumping it, silently serves a stale
   * snapshot.
   */
  const touch = (state: UploadState): void => {
    state.version += 1;
    observable.invalidate();
  };

  const persist = async (state: UploadState): Promise<void> => {
    if (store === null || state.key === null || state.uploadId === null) return;
    if (state.status === "succeeded" || state.status === "cancelled") {
      await store.remove(state.id);
      return;
    }
    await store.put(toRecord(state, settings.partSize, platform.now()));
  };

  const deps: UploadDeps = {
    platform,
    transport: options.transport,
    settings,
    budget,
    onChange: touch,
    onPartLanded: (uploadId, partNumber) =>
      observable.emit("part:landed", { uploadId, partNumber }),
    onRetrying: (uploadId, partNumber, attempt, delayMs) =>
      observable.emit("part:retrying", { uploadId, partNumber, attempt, delayMs }),
    onRecord: persist,
  };

  const announce = (state: UploadState): void => {
    if (state.status === "succeeded") observable.emit("upload:succeeded", { uploadId: state.id });
    else if (state.status === "failed" && state.error !== null)
      observable.emit("upload:failed", { uploadId: state.id, error: state.error });
    else if (state.status === "cancelled") observable.emit("upload:cancelled", { uploadId: state.id });
    else if (state.status === "paused") observable.emit("upload:paused", { uploadId: state.id });
  };

  const drive = (state: UploadState): Promise<void> => {
    const pending = runUpload(state, deps)
      .then(async () => {
        await persist(state);
        announce(state);
      })
      .finally(() => running.delete(state.id));
    running.set(state.id, pending);
    return pending;
  };

  const settleBatch = (): BatchSnapshot => {
    const snapshot = observable.read();
    observable.emit("batch:settled", { status: snapshot.status });
    return snapshot;
  };

  const targetsFor = (uploadId?: string): UploadState[] =>
    uploadId === undefined ? states : states.filter((state) => state.id === uploadId);

  const start = async (): Promise<BatchSnapshot> => {
    await Promise.all(states.map(drive));
    return settleBatch();
  };

  /** Stop the named Uploads, then wait for their runs to unwind. */
  const halt = async (targets: UploadState[], intent: "pause" | "cancel"): Promise<void> => {
    for (const state of targets) {
      if (isTerminal(state)) continue;
      state.intent = intent;
      state.controller?.abort();

      // An Upload with nothing in flight has no run to settle it, so it must be
      // moved here — otherwise cancelling something already paused or failed
      // would silently leave it where it was.
      if (running.has(state.id)) continue;

      if (intent === "cancel") {
        state.status = "cancelled";
        state.error = null;
        touch(state);
        announce(state);
      } else if (state.status === "pending") {
        // Pausing a failed Upload leaves it failed; there is nothing to defer.
        state.status = "paused";
        touch(state);
        announce(state);
      }
    }
    await Promise.all(targets.map((state) => running.get(state.id) ?? Promise.resolve()));
  };

  const pause = async (uploadId?: string): Promise<BatchSnapshot> => {
    await halt(targetsFor(uploadId), "pause");
    return observable.read();
  };

  const cancel = async (uploadId?: string): Promise<BatchSnapshot> => {
    const targets = targetsFor(uploadId);
    await halt(targets, "cancel");

    for (const state of targets) {
      // Tear down exactly once, and only when there is something to tear down.
      // A succeeded Upload must never be aborted — the object already exists.
      if (state.status !== "cancelled") continue;
      if (state.key === null || state.uploadId === null) continue;
      if (tornDown.has(state.id)) continue;
      tornDown.add(state.id);
      try {
        await options.transport.abort({ key: state.key, uploadId: state.uploadId });
      } catch {
        // Tearing down is best-effort: the lifecycle rule is the backstop.
      }
      await persist(state);
    }

    return observable.read();
  };

  const resume = async (uploadId?: string): Promise<BatchSnapshot> => {
    const targets = targetsFor(uploadId);

    if (uploadId !== undefined) {
      const state = targets[0];
      if (state === undefined) {
        throw uploadError("NOT_RESUMABLE", `No Upload with id ${uploadId}.`);
      }
      if (state.status === "cancelled") {
        throw uploadError(
          "NOT_RESUMABLE",
          "A cancelled Upload cannot be resumed — Cancel discards the work.",
        );
      }
      if (state.status === "succeeded") return observable.read();
    }

    const resumable = targets.filter(isResumable);
    if (resumable.length === 0) return observable.read();

    await Promise.all(resumable.map(drive));
    return settleBatch();
  };

  const purgeStale = async (): Promise<void> => {
    if (store === null) return;
    const now = platform.now();
    const records = await store.list();
    await Promise.all(
      records
        .filter((record) => now - record.updatedAt > recordTtlMs)
        .map((record) => store.remove(record.id)),
    );
  };

  void purgeStale();

  return {
    start,
    resume,
    pause,
    cancel,
    getSnapshot: observable.read,
    subscribe: observable.subscribe,
    on: observable.on,
  };
};
