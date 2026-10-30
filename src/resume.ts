import { createSeededUploader } from "./uploader.js";
import { uploadError } from "./errors.js";
import { assertFingerprint } from "./fingerprint.js";
import { sliceParts } from "./plan.js";
import { browserPlatform } from "./platform/browser.js";
import { defaultStore } from "./platform/indexeddb-store.js";
import {
  DEFAULT_RECORD_TTL_MS,
  dropStaleRecords,
  type RecordStore,
  type UploadRecord,
} from "./store.js";
import { assertResumeOptions } from "./validate.js";
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
  /** Parts in the Upload. */
  partCount: number;
  /** Parts already stored at the provider — what a Resume will not re-send. */
  landedPartCount: number;
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

  const fresh = await dropStaleRecords(store, platform.now(), recordTtlMs);

  return fresh.map((record) => ({
    id: record.id,
    file: record.file,
    key: record.key,
    uploadId: record.uploadId,
    partCount: record.partCount,
    landedPartCount: record.landed.length,
    updatedAt: record.updatedAt,
    recovery: record.handle !== null && platform.files?.isHandleSupported() ? "handle" : "reselect",
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
   * is, every Record whose File Handle still opens and still holds the same
   * file. Anything else is skipped, not thrown: a refused permission prompt, a
   * moved file, or a browser without handles. Those Records stay listed by
   * `listResumable`, for the application to offer a file picker for.
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
export const resumeUploader = async (options: ResumeUploaderOptions): Promise<Uploader> => {
  assertResumeOptions(options);
  const platform = options.platform ?? browserPlatform();
  const store = options.store === undefined ? defaultStore() : options.store;
  const seed: UploadState[] = [];

  const takeAll = options.resume === "all";
  const specs: ResumeSpec[] = takeAll
    ? (await listResumable({ store, platform, recordTtlMs: options.recordTtlMs }))
        .filter((found) => found.recovery === "handle")
        .map((found) => ({ id: found.id }))
    : (options.resume as ResumeSpec[]);

  for (const spec of specs) {
    // Named Uploads with nowhere to have been recorded: say so, rather than
    // handing back an Uploader that quietly holds nothing.
    const record = store === null ? null : await store.get(spec.id);
    // Gone since it was listed — another tab finished or cancelled it.
    if (record === null && takeAll) continue;
    if (record === null) {
      throw uploadError("NOT_RESUMABLE", `No Upload Record for ${spec.id}.`);
    }

    const file = await recoverFile(record, spec, platform, options);
    if (file === null) {
      if (takeAll) continue;
      throw uploadError(
        "FILE_REQUIRED",
        `Resuming "${record.file.name}" needs the file again — this browser cannot recover its bytes on its own.`,
      );
    }
    const state = createUploadState(record.id, file, record.handle);

    state.key = record.key;
    state.uploadId = record.uploadId;
    state.partSize = record.partSize;
    // The upload was created expecting checksums or not; that cannot change now.
    state.checksum = record.checksum;
    if (record.checksum !== undefined && options.transport.signParts === undefined) {
      throw uploadError(
        "INVALID_OPTIONS",
        `Upload ${record.id} was started with checksums, so resuming it needs a Transport with signParts.`,
      );
    }
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
    const landed = new Map(record.landed.map((part) => [part.partNumber, part]));
    for (const part of state.parts) {
      const found = landed.get(part.partNumber);
      if (found === undefined) continue;
      part.status = "landed";
      part.eTag = found.eTag;
      part.checksumCRC32 = found.checksumCRC32 ?? null;
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
  return createSeededUploader({ ...options, store, files: [], seed });
};

/**
 * Re-open the bytes through the stored handle. Null whenever that cannot be
 * done — no handle, no support, permission refused, the file moved or changed
 * — because every one of those has the same remedy: ask the user for the file.
 */
const fromHandle = async (
  record: UploadRecord,
  platform: Platform,
  options: ResumeUploaderOptions,
): Promise<File | null> => {
  const files = platform.files;
  if (record.handle === null || !files?.isHandleSupported()) return null;
  try {
    if (!(await files.requestPermission(record.handle))) return null;
    const file = await files.readFile(record.handle);
    assertFingerprint(record.file, describeFile(file), options.fingerprint);
    return file;
  } catch {
    return null;
  }
};

/** The handle if it still works, else the file the user re-selected. Null when neither. */
const recoverFile = async (
  record: UploadRecord,
  spec: ResumeSpec,
  platform: Platform,
  options: ResumeUploaderOptions,
): Promise<File | null> => {
  const viaHandle = await fromHandle(record, platform, options);
  if (viaHandle !== null) return viaHandle;
  if (spec.file === undefined) return null;
  // A re-selected file that does not match is the user's mistake to hear about.
  assertFingerprint(record.file, describeFile(spec.file), options.fingerprint);
  return spec.file;
};
