import { defaultClassifier } from "./classify.js";
import { uploadError } from "./errors.js";
import { createObservable } from "./observable.js";
import { browserPlatform } from "./platform/browser.js";
import { createSemaphore } from "./semaphore.js";
import { DEFAULT_RECORD_TTL_MS, defaultStore, type UploadRecord } from "./store.js";
import { assertUploaderOptions, isFileLike } from "./validate.js";
import { PROVIDERS } from "./types.js";
import type {
  Uploader,
  UploadFile,
  ProviderLimits,
  UploaderOptions,
  UploaderSnapshot,
  UploaderStatus,
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

/** Shortest gap between two progress writes of the same Upload Record. */
const RECORD_INTERVAL_MS = 2_000;

/**
 * Below this many Parts, every landed Part is written down.
 *
 * A Record rewrites whole, so writing on every Part costs O(n^2) bytes across
 * an Upload. At a few hundred Parts that is nothing and the durability is worth
 * having; at ten thousand it is not, and those writes get coalesced instead.
 */
const COALESCE_ABOVE_PARTS = 200;

const DEFAULTS = {
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
const deriveStatus = (uploads: UploadSnapshot[]): UploaderStatus => {
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

const toRecord = (state: UploadState, now: number): UploadRecord => ({
  id: state.id,
  key: state.key as string,
  uploadId: state.uploadId as string,
  file: state.descriptor,
  partSize: state.partSize,
  partCount: state.parts.length,
  landed: state.parts
    .filter((part) => part.status === "landed" && part.eTag !== null)
    .map((part) => ({ partNumber: part.partNumber, eTag: part.eTag as string })),
  updatedAt: now,
  handle: state.handle,
});

const toInput = (entry: UploadFile): { file: File; handle: unknown } =>
  isFileLike(entry) ? { file: entry, handle: null } : { file: entry.file, handle: entry.handle ?? null };

interface UploaderInternalOptions extends UploaderOptions {
  /** Pre-built states, used when taking up Uploads recovered from the store. */
  seed?: UploadState[];
}

const buildBatch = (options: UploaderInternalOptions): Uploader => {
  const platform = options.platform ?? browserPlatform();
  // undefined means "you choose"; null means "keep none".
  const store = options.store === undefined ? defaultStore() : options.store;
  const recordTtlMs = options.recordTtlMs ?? DEFAULT_RECORD_TTL_MS;

  // A named provider or explicit limits; "s3" suits every S3-compatible one.
  const limits: ProviderLimits =
    typeof options.provider === "string"
      ? PROVIDERS[options.provider]
      : (options.provider ?? PROVIDERS.s3);

  const settings: UploadSettings = {
    // Left unset, the size is chosen per file — a fixed one cannot serve both a
    // 3 MB file and a 300 GB one, which needs ~30.7 MiB Parts to fit in 10,000.
    partSize: options.partSize ?? "auto",
    minPartSize: limits.minPartSize ?? PROVIDERS.s3.minPartSize,
    maxParts: limits.maxParts ?? PROVIDERS.s3.maxParts,
    maxPartSize: limits.maxPartSize ?? PROVIDERS.s3.maxPartSize,
    maxObjectSize: limits.maxObjectSize ?? PROVIDERS.s3.maxObjectSize,
    concurrency: options.concurrency ?? DEFAULTS.concurrency,
    maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
    retryBaseMs: options.retryBaseMs ?? DEFAULTS.retryBaseMs,
    retryMaxMs: options.retryMaxMs ?? DEFAULTS.retryMaxMs,
    partTimeoutMs: options.partTimeoutMs ?? DEFAULTS.partTimeoutMs,
    waitWhileOffline: options.waitWhileOffline ?? DEFAULTS.waitWhileOffline,
    contentType: options.contentType,
    classify: options.classify ?? defaultClassifier,
    // Enough Parts signed ahead that the Connection Budget never waits on the
    // signing round trip, without signing thousands nobody will reach today.
    urlWindow: options.urlWindow ?? (options.concurrency ?? DEFAULTS.concurrency) * 4,
  };

  const states: UploadState[] =
    options.seed ??
    options.files.map((entry) => {
      const { file, handle } = toInput(entry);
      return createUploadState(platform.newId(), file, handle);
    });

  const budget = createSemaphore(settings.concurrency);
  const running = new Map<string, Promise<void>>();
  const tornDown = new Set<string>();

  // An Upload's snapshot is rebuilt only when that Upload changed. Without this
  // a progress tick on one file re-copied the Parts of every file in the Batch.
  const cache = new Map<string, UploadSnapshot>();

  const cachedSnapshot = (state: UploadState): UploadSnapshot => {
    const hit = cache.get(state.id);
    if (hit !== undefined) return hit;
    const snapshot = snapshotUpload(state);
    cache.set(state.id, snapshot);
    return snapshot;
  };

  const buildSnapshot = (): UploaderSnapshot => {
    const uploads = states.map(cachedSnapshot);
    const total = uploads.reduce((sum, upload) => sum + upload.progress.total, 0);
    const loaded = uploads.reduce((sum, upload) => sum + upload.progress.loaded, 0);
    return Object.freeze({
      status: deriveStatus(uploads),
      progress: progressOf(loaded, total),
      uploads: Object.freeze(uploads) as UploadSnapshot[],
      file: uploads.length === 1 ? uploads[0]! : null,
    });
  };

  const observable = createObservable(buildSnapshot);

  /**
   * Record that an Upload changed. Every mutation must come through here — that
   * is the one rule. One operation, so nothing can get out of step and serve a
   * frozen snapshot.
   */
  const touch = (state: UploadState): void => {
    cache.delete(state.id);
    observable.invalidate();
  };

  // The exposure from coalescing is bounded: a tab that dies mid-interval loses
  // only the Parts that landed inside it, and a Resume re-sends those.
  const lastWriteAt = new Map<string, number>();

  /**
   * Run one Record Store call, best-effort.
   *
   * The store is droppable — omit it and you lose Durable Resume. A store that
   * *rejects* must cost the same and no more, never the Upload. Reported rather
   * than swallowed so it stays diagnosable.
   */
  const attemptStore = async (what: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      console.warn(`presigned-multipart-upload: the Record Store failed to ${what}`, error);
    }
  };

  const persist = async (
    state: UploadState,
    occasion: "milestone" | "progress" = "milestone",
  ): Promise<void> => {
    if (store === null || state.key === null || state.uploadId === null) return;

    if (state.status === "succeeded" || state.status === "cancelled") {
      lastWriteAt.delete(state.id);
      await attemptStore("remove a Record", () => store.remove(state.id));
      return;
    }

    const now = platform.now();
    const coalesce =
      occasion === "progress" &&
      state.parts.length > COALESCE_ABOVE_PARTS &&
      now - (lastWriteAt.get(state.id) ?? 0) < RECORD_INTERVAL_MS;
    if (coalesce) return;

    lastWriteAt.set(state.id, now);
    await attemptStore("write a Record", () => store.put(toRecord(state, now)));
  };

  const deps: UploadDeps = {
    platform,
    transport: options.transport,
    settings,
    budget,
    onChange: touch,
    onPartLanded: (uploadId, partNumber) =>
      observable.emit("part:landed", { id: uploadId, partNumber }),
    onRetrying: (uploadId, partNumber, attempt, delayMs) =>
      observable.emit("part:retrying", { id: uploadId, partNumber, attempt, delayMs }),
    onRecord: persist,
  };

  const announce = (state: UploadState): void => {
    if (state.status === "succeeded") observable.emit("upload:succeeded", { id: state.id });
    else if (state.status === "failed" && state.error !== null)
      observable.emit("upload:failed", { id: state.id, error: state.error });
    else if (state.status === "cancelled") observable.emit("upload:cancelled", { id: state.id });
    else if (state.status === "paused") observable.emit("upload:paused", { id: state.id });
  };

  const drive = (state: UploadState): Promise<void> => {
    // Join a run already under way rather than racing a second one on the same
    // Upload State: two runs would send every Part twice, and the second would
    // overwrite the controller the first aborts through.
    const inFlight = running.get(state.id);
    if (inFlight !== undefined) return inFlight;

    // Terminal is terminal. A succeeded Upload has finalised its object and a
    // cancelled one was torn down at the provider, so running either again
    // writes Parts into an upload that is finished or gone.
    if (isTerminal(state)) return Promise.resolve();

    const pending = runUpload(state, deps)
      .then(async () => {
        await persist(state);
        announce(state);
      })
      .finally(() => running.delete(state.id));
    running.set(state.id, pending);
    return pending;
  };

  const settleBatch = (): UploaderSnapshot => {
    const snapshot = observable.read();
    observable.emit("uploader:settled", { status: snapshot.status });
    return snapshot;
  };

  const targetsFor = (id?: string): UploadState[] =>
    id === undefined ? states : states.filter((state) => state.id === id);

  const start = async (): Promise<UploaderSnapshot> => {
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

  const pause = async (id?: string): Promise<UploaderSnapshot> => {
    await halt(targetsFor(id), "pause");
    return observable.read();
  };

  const cancel = async (id?: string): Promise<UploaderSnapshot> => {
    const targets = targetsFor(id);
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

  const resume = async (id?: string): Promise<UploaderSnapshot> => {
    const targets = targetsFor(id);

    if (id !== undefined) {
      const state = targets[0];
      if (state === undefined) {
        throw uploadError("NOT_RESUMABLE", `No Upload with id ${id}.`);
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

  // Housekeeping, fired and forgotten at construction: it must not reject into
  // a caller who only asked for a Batch.
  void attemptStore("drop stale Records", purgeStale);

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

/**
 * Build an Uploader from Upload States that already exist. Internal, and a
 * separate symbol so `UploadState` stays out of the shipped declarations.
 */
export const createSeededUploader = (options: UploaderInternalOptions): Uploader =>
  buildBatch(options);

export const createUploader = (options: UploaderOptions): Uploader => {
  assertUploaderOptions(options);
  return buildBatch(options);
};

/**
 * What every framework Adapter accepts: the options, or an Uploader you already
 * built.
 *
 * Options is the ordinary case, and it means an adopter learns one function
 * instead of two. Passing a built Uploader is for sharing one across components
 * — a page-wide upload tray bound in several places.
 */
export type UploaderSource = UploaderOptions | Uploader;

export const toUploader = (source: UploaderSource): Uploader =>
  "getSnapshot" in source ? source : createUploader(source);
