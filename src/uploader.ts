import { defaultClassifier } from "./classify.js";
import { uploadError } from "./errors.js";
import { createObservable } from "./observable.js";
import { browserPlatform } from "./platform/browser.js";
import { createSemaphore } from "./semaphore.js";
import { defaultStore } from "./platform/indexeddb-store.js";
import { DEFAULT_RECORD_TTL_MS, dropStaleRecords, type UploadRecord } from "./store.js";
import { assertUploaderOptions, isFileLike } from "./validate.js";
import { S3_LIMITS } from "./types.js";
import type {
  Uploader,
  UploadFile,
  UploaderOptions,
  UploaderSnapshot,
  UploaderStatus,
  UploadSnapshot,
} from "./types.js";
import { createRateMeter, progressOf, type RateMeter } from "./progress.js";
import {
  completedParts,
  createUploadState,
  isActive,
  isActiveStatus,
  loadedSoFar,
  isResumable,
  isTerminal,
  runUpload,
  targetOf,
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

const snapshotUpload = (state: UploadState, bytesPerSecond: number | null): UploadSnapshot => {
  const total = state.descriptor.size;
  return Object.freeze({
    id: state.id,
    file: state.descriptor,
    status: state.status,
    progress: progressOf(loadedSoFar(state), total, bytesPerSecond),
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

  const active = uploads.some((upload) => isActiveStatus(upload.status));
  if (active) return "uploading";

  if (uploads.some((upload) => upload.status === "failed")) return "failed";
  if (uploads.some((upload) => upload.status === "paused")) return "paused";
  if (uploads.some((upload) => upload.status === "cancelled")) return "cancelled";
  if (uploads.some((upload) => upload.status === "pending")) return "uploading";
  return "succeeded";
};

const toRecord = (state: UploadState, now: number): UploadRecord => ({
  id: state.id,
  ...targetOf(state),
  file: state.descriptor,
  partSize: state.partSize,
  partCount: state.parts.length,
  landed: completedParts(state.parts),
  ...(state.checksum === undefined ? {} : { checksum: state.checksum }),
  updatedAt: now,
  handle: state.handle,
});

const toInput = (entry: UploadFile): { file: File; handle: unknown } =>
  isFileLike(entry)
    ? { file: entry, handle: null }
    : { file: entry.file, handle: entry.handle ?? null };

interface UploaderInternalOptions extends UploaderOptions {
  /** Pre-built states, used when taking up Uploads recovered from the store. */
  seed?: UploadState[];
}

const buildBatch = (options: UploaderInternalOptions): Uploader => {
  const platform = options.platform ?? browserPlatform();
  // undefined means "you choose"; null means "keep none".
  const store = options.store === undefined ? defaultStore() : options.store;
  const recordTtlMs = options.recordTtlMs ?? DEFAULT_RECORD_TTL_MS;

  const settings: UploadSettings = {
    // Left unset, the size is chosen per file — a fixed one cannot serve both a
    // 3 MB file and a 300 GB one, which needs ~30.7 MiB Parts to fit in 10,000.
    partSize: options.partSize ?? "auto",
    limits: { ...S3_LIMITS, ...options.limits },
    concurrency: options.concurrency ?? DEFAULTS.concurrency,
    maxRetries: options.retry?.max ?? DEFAULTS.maxRetries,
    retryBaseMs: options.retry?.baseMs ?? DEFAULTS.retryBaseMs,
    retryMaxMs: options.retry?.maxMs ?? DEFAULTS.retryMaxMs,
    partTimeoutMs: options.retry?.timeoutMs ?? DEFAULTS.partTimeoutMs,
    waitWhileOffline: options.waitWhileOffline ?? DEFAULTS.waitWhileOffline,
    classify: options.classify ?? defaultClassifier,
    // Enough Parts signed ahead that the Connection Budget never waits on the
    // signing round trip, without signing thousands nobody will reach today.
    // With checksums, every Part in a window is read before the window is
    // signed, so a smaller one gets the first bytes moving sooner.
    urlWindow:
      options.urlWindow ??
      (options.concurrency ?? DEFAULTS.concurrency) * (options.checksum === undefined ? 4 : 1),
    checksum: options.checksum,
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

  // One speed per Upload; the Batch's is their sum, since they share the pipe.
  const meters = new Map<string, RateMeter>();
  const meterFor = (state: UploadState): RateMeter => {
    const found = meters.get(state.id);
    if (found !== undefined) return found;
    const meter = createRateMeter();
    meters.set(state.id, meter);
    return meter;
  };

  const speedOf = (state: UploadState): number | null =>
    isActive(state) ? meterFor(state).rate(platform.now()) : null;

  const cachedSnapshot = (state: UploadState): UploadSnapshot => {
    const speed = speedOf(state);
    const hit = cache.get(state.id);
    // A speed can lapse with no change to the Upload — a stalled transfer — so
    // a cached snapshot is reused only while its speed still holds.
    if (hit !== undefined && hit.progress.bytesPerSecond === speed) return hit;
    const snapshot = snapshotUpload(state, speed);
    cache.set(state.id, snapshot);
    return snapshot;
  };

  const buildSnapshot = (): UploaderSnapshot => {
    const uploads = states.map(cachedSnapshot);
    const total = uploads.reduce((sum, upload) => sum + upload.progress.total, 0);
    const loaded = uploads.reduce((sum, upload) => sum + upload.progress.loaded, 0);
    const speeds = uploads
      .map((upload) => upload.progress.bytesPerSecond)
      .filter((speed): speed is number => speed !== null);
    // Only bytes that are going to move count toward the ETA: a failed or
    // paused sibling's remainder is not waiting on this connection.
    const outstanding = uploads
      .filter((upload) => upload.status === "pending" || isActiveStatus(upload.status))
      .reduce((sum, upload) => sum + (upload.progress.total - upload.progress.loaded), 0);
    return Object.freeze({
      status: deriveStatus(uploads),
      progress: progressOf(
        loaded,
        total,
        speeds.length === 0 ? null : speeds.reduce((sum, speed) => sum + speed, 0),
        outstanding,
      ),
      uploads: Object.freeze(uploads) as UploadSnapshot[],
      upload: uploads.length === 1 ? uploads[0]! : null,
    });
  };

  const observable = createObservable(buildSnapshot);

  /**
   * Record that an Upload changed. Every mutation must come through here — that
   * is the one rule. One operation, so nothing can get out of step and serve a
   * frozen snapshot.
   */
  const touch = (state: UploadState): void => {
    // Speed is sampled here because every change passes through here; a run
    // that stops forgets its samples, so a Resume measures afresh.
    const meter = meterFor(state);
    if (isActive(state)) meter.sample(platform.now(), loadedSoFar(state));
    else meter.reset();
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
    onPartLanded: (id, partNumber) => observable.emit("part:landed", { id, partNumber }),
    onRetrying: (id, partNumber, attempt, delayMs) =>
      observable.emit("part:retrying", { id, partNumber, attempt, delayMs }),
    onRecord: persist,
  };

  const announce = (state: UploadState): void => {
    if (state.status === "succeeded") observable.emit("upload:succeeded", { id: state.id });
    else if (state.status === "failed" && state.error !== null)
      observable.emit("upload:failed", { id: state.id, error: state.error });
    else if (state.status === "cancelled") observable.emit("upload:cancelled", { id: state.id });
    else if (state.status === "paused") observable.emit("upload:paused", { id: state.id });
  };

  /**
   * While anything runs, re-check each speed once a second. A transfer that
   * stalls changes nothing, so without this its last speed would stay on
   * screen; the tick samples it, and a speed with no fresh bytes lapses.
   */
  let stopTicking: (() => void) | null = null;
  const tick = (): void => {
    for (const state of states) if (isActive(state)) touch(state);
  };
  const keepTicking = (): void => {
    if (stopTicking === null && platform.every) stopTicking = platform.every(1_000, tick);
  };
  const maybeStopTicking = (): void => {
    if (running.size > 0 || stopTicking === null) return;
    stopTicking();
    stopTicking = null;
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
      .finally(() => {
        running.delete(state.id);
        maybeStopTicking();
      });
    running.set(state.id, pending);
    keepTicking();
    return pending;
  };

  /**
   * Announce that the Batch has stopped — once, and only when it has. A
   * `resume(id)` that finishes while a sibling is still running has settled
   * that Upload, not the Batch.
   */
  const settleBatch = (): UploaderSnapshot => {
    const snapshot = observable.read();
    if (running.size === 0) observable.emit("uploader:settled", { status: snapshot.status });
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
        await options.transport.abort(targetOf(state));
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

  // Housekeeping, fired and forgotten at construction: it must not reject into
  // a caller who only asked for a Batch.
  if (store !== null) {
    void attemptStore("drop stale Records", () =>
      dropStaleRecords(store, platform.now(), recordTtlMs),
    );
  }

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

/** Whether an Adapter was handed a built Uploader rather than options. */
export const isUploader = (source: UploaderSource): source is Uploader => "getSnapshot" in source;

export const toUploader = (source: UploaderSource): Uploader =>
  isUploader(source) ? source : createUploader(source);
