import { createBatch } from "./batch.js";
import { uploadError } from "./errors.js";
import { assertFingerprint } from "./fingerprint.js";
import { planParts } from "./plan.js";
import { browserPlatform } from "./platform/browser.js";
import { isStale, type RecordStore, type UploadRecord } from "./store.js";
import { createUploadState, describeFile, type UploadState } from "./upload.js";
import type { BatchController, BatchOptions, FileDescriptor, Platform } from "./types.js";

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
  store: RecordStore;
  platform?: Platform;
  recordTtlMs?: number;
}

const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000;

/**
 * Find Uploads left unfinished by an earlier page session.
 *
 * Stale Records are dropped as they are found, so abandoned Uploads do not
 * accumulate in browser storage forever.
 */
export const listResumable = async ({
  store,
  platform = browserPlatform(),
  recordTtlMs = DEFAULT_TTL,
}: ListResumableOptions): Promise<ResumableUpload[]> => {
  const now = platform.now();
  const records = await store.list();
  const fresh: UploadRecord[] = [];

  for (const record of records) {
    if (isStale(record, now, recordTtlMs)) {
      await store.remove(record.id);
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

export interface CreateResumedBatchOptions extends Omit<BatchOptions, "files"> {
  store: RecordStore;
  resume: ResumeSpec[];
}

/**
 * Rebuild a Batch from Upload Records so it can be continued.
 *
 * Both halves of Durable Resume must be present: the Record, which the library
 * always keeps, and the bytes, which come either from a stored handle or from
 * the file the user re-selected. A handle whose permission is refused falls back
 * to needing a re-selection rather than throwing.
 */
export const createResumedBatch = async (
  options: CreateResumedBatchOptions,
): Promise<BatchController> => {
  const platform = options.platform ?? browserPlatform();
  const seed: UploadState[] = [];

  for (const spec of options.resume) {
    const record = await options.store.get(spec.id);
    if (record === null) {
      throw uploadError("NOT_RESUMABLE", `No Upload Record for ${spec.id}.`);
    }

    const file = await recoverFile(record, spec, platform, options);
    const state = createUploadState(record.id, file, record.handle);

    state.key = record.key;
    state.uploadId = record.uploadId;
    state.parts = planParts({
      size: record.file.size,
      partSize: record.partSize,
      minPartSize: options.minPartSize ?? 1,
      maxParts: options.maxParts ?? 10_000,
    });

    // Mark what already landed so the Resume sends only what is missing.
    const landed = new Map(record.landed.map((part) => [part.partNumber, part.eTag]));
    for (const part of state.parts) {
      const eTag = landed.get(part.partNumber);
      if (eTag === undefined) continue;
      part.status = "landed";
      part.eTag = eTag;
      part.loaded = part.size;
    }

    // "failed" is what makes the Upload resumable to the controller; nothing
    // about the previous session's ending is knowable from here.
    state.status = "failed";
    state.error = { code: "NOT_RESUMABLE", message: "Interrupted by an earlier page session." };
    seed.push(state);
  }

  return createBatch({ ...options, files: [], seed, partSize: options.partSize });
};

const recoverFile = async (
  record: UploadRecord,
  spec: ResumeSpec,
  platform: Platform,
  options: CreateResumedBatchOptions,
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
