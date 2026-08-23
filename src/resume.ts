import { createSeededUploader } from "./uploader.js";
import { uploadError } from "./errors.js";
import { assertFingerprint } from "./fingerprint.js";
import { sliceParts } from "./plan.js";
import { browserPlatform } from "./platform/browser.js";
import {
  DEFAULT_RECORD_TTL_MS,
  defaultStore,
  isStale,
  type RecordStore,
  type UploadRecord,
} from "./store.js";
import { createUploadState, describeFile, type UploadState } from "./upload.js";
import type { Uploader, UploaderOptions, FileDescriptor, Platform } from "./types.js";

/** How an interrupted Upload's bytes can be recovered. */
export type Recovery =
  /** A durable handle survived; the bytes come back with no user involvement. */
  | "handle"
  /** The user must select the file again before this Upload can continue. */
  | "reselect";

export interface ResumableUpload {
  id: string;
  file: FileDescriptor;
  key: string;
  uploadId: string;
  landedParts: number;
  totalParts: number;
  updatedAt: number;
  /**
   * Which path applies. The application shows a file picker for "reselect" and
   * nothing at all for "handle" — it should never have to test browser support
   * itself.
   */
  recovery: Recovery;
}

export interface ListResumableOptions {
  /** Defaults to the same store `createUploader` writes to. `null` finds none. */
  store?: RecordStore | null;
  platform?: Platform;
  recordTtlMs?: number;
}


/**
 * Find Uploads left unfinished by an earlier page session.
 *
 * Stale Records are dropped as they are found, so abandoned Uploads do not
 * accumulate in browser storage forever.
 */
export const listResumable = async ({
  store: given,
  platform = browserPlatform(),
  recordTtlMs = DEFAULT_RECORD_TTL_MS,
}: ListResumableOptions = {}): Promise<ResumableUpload[]> => {
  const store = given === undefined ? defaultStore() : given;
  if (store === null) return [];

  const now = platform.now();
  const records = await store.list();
  const fresh: UploadRecord[] = [];

  for (const record of records) {
    if (isStale(record, now, recordTtlMs)) {
      // Housekeeping. A store that cannot drop a stale Record must not stop the
      // caller learning about the fresh ones.
      await store.remove(record.id).catch((error: unknown) => {
        console.warn("presigned-multipart-upload: the Record Store failed to drop a stale Record", error);
      });
      continue;
    }
    fresh.push(record);
  }

  return fresh.map((record) => ({
    id: record.id,
    file: record.file,
    key: record.key,
    uploadId: record.uploadId,
    landedParts: record.landed.length,
    totalParts: record.partCount,
    updatedAt: record.updatedAt,
    recovery:
      record.handle !== null && platform.files?.isHandleSupported() ? "handle" : "reselect",
  }));
};

export interface ResumeSpec {
  id: string;
  /** Required when recovery is "reselect"; ignored when a handle works. */
  file?: File;
}

export interface ResumeUploaderOptions extends Omit<UploaderOptions, "files"> {
  /**
   * Which interrupted Uploads to take up.
   *
   * `"all"` picks up everything recoverable without involving the user — that
   * is, every Record whose File Handle still works. Records needing the file
   * re-selected are skipped, because only the application can ask for it; list
   * them with `listResumable` and pass explicit specs to handle those.
   */
  resume: ResumeSpec[] | "all";
}

/**
 * Rebuild a Batch from Upload Records so it can be continued.
 *
 * Both halves of Durable Resume must be present: the Record, which the library
 * always keeps, and the bytes, which come either from a stored handle or from
 * the file the user re-selected. A handle whose permission is refused falls back
 * to needing a re-selection rather than throwing.
 */
export const resumeUploader = async (
  options: ResumeUploaderOptions,
): Promise<Uploader> => {
  const platform = options.platform ?? browserPlatform();
  const store = options.store === undefined ? defaultStore() : options.store;
  const seed: UploadState[] = [];

  const specs =
    options.resume === "all"
      ? (await listResumable({ store, platform, recordTtlMs: options.recordTtlMs }))
          .filter((found) => found.recovery === "handle")
          .map((found) => ({ id: found.id }))
      : options.resume;

  for (const spec of specs) {
    // Named Uploads with nowhere to have been recorded: say so, rather than
    // handing back an Uploader that quietly holds nothing.
    const record = store === null ? null : await store.get(spec.id);
    if (record === null) {
      throw uploadError("NOT_RESUMABLE", `No Upload Record for ${spec.id}.`);
    }

    const file = await recoverFile(record, spec, platform, options);
    const state = createUploadState(record.id, file, record.handle);

    state.key = record.key;
    state.uploadId = record.uploadId;
    state.partSize = record.partSize;
    // The Record already holds a plan the provider accepted, so the limits are
    // not re-litigated — only the byte ranges are recut, from the size the first
    // run used. Cutting them any other way would misalign every Part.
    state.parts = sliceParts(record.file.size, record.partSize);

    if (state.parts.length !== record.partCount) {
      throw uploadError(
        "NOT_RESUMABLE",
        `Upload Record ${record.id} describes ${record.partCount} Parts but its size and Part size give ${state.parts.length}.`,
      );
    }

    // Mark what already landed so the Resume sends only what is missing.
    const landed = new Map(record.landed.map((part) => [part.partNumber, part.eTag]));
    for (const part of state.parts) {
      const eTag = landed.get(part.partNumber);
      if (eTag === undefined) continue;
      part.status = "landed";
      part.eTag = eTag;
      part.loaded = part.size;
    }

    // Paused, not failed. Nothing about the previous session's ending is
    // knowable from here, and this is exactly Pause: work deferred, waiting.
    state.status = "paused";
    state.error = null;
    seed.push(state);
  }

  // The resolved store, not the given one, so the revived Uploader keeps
  // writing where the Records were found.
  return createSeededUploader({ ...options, store, files: [], seed, partSize: options.partSize });
};

const recoverFile = async (
  record: UploadRecord,
  spec: ResumeSpec,
  platform: Platform,
  options: ResumeUploaderOptions,
): Promise<File> => {
  const files = platform.files;
  if (record.handle !== null && files?.isHandleSupported()) {
    const permitted = await files.requestPermission(record.handle).catch(() => false);
    if (permitted) {
      const file = await files.readFile(record.handle);
      assertFingerprint(record.file, describeFile(file), options.fingerprint);
      return file;
    }
  }

  if (spec.file === undefined) {
    throw uploadError(
      "FILE_REQUIRED",
      `Resuming "${record.file.name}" needs the file again — this browser cannot recover its bytes on its own.`,
    );
  }

  assertFingerprint(record.file, describeFile(spec.file), options.fingerprint);
  return spec.file;
};
