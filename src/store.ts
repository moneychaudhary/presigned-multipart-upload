import type { ChecksumAlgorithm, CompletedPart, FileDescriptor } from "./types.js";

/** The persisted account of an Upload that has not finished. */
export interface UploadRecord {
  id: string;
  key: string;
  uploadId: string;
  file: FileDescriptor;
  partSize: number;
  partCount: number;
  /** Parts that landed, with the ETags — and checksums — finalising will need. */
  landed: CompletedPart[];
  /** Set when the upload was created expecting checksums; a Resume must keep sending them. */
  checksum?: ChecksumAlgorithm;
  updatedAt: number;
  /**
   * A durable reference to the file on the user's device, where the browser can
   * provide one. Structured-cloneable, which is why the browser store must be
   * IndexedDB — a File Handle cannot be put in localStorage.
   */
  handle: unknown;
}

/**
 * Where Upload Records live between page sessions.
 *
 * Swappable so an application can scope Records to the signed-in user and clear
 * them on sign-out — one person must never Resume another's Upload on a shared
 * device.
 */
export interface RecordStore {
  /**
   * Any of these may reject — browser storage runs out, a private-mode tab
   * refuses to persist, a user clears site data mid-upload.
   *
   * A rejection costs Durable Resume and nothing else. The Core reports it and
   * carries on: an Upload in flight is not failed, its siblings are not
   * abandoned, and a Record that could not be written simply is not there to
   * Resume from later. `listResumable` and `resumeUploader` are the
   * exception — a caller asking to read Records is told when that fails.
   */
  put: (record: UploadRecord) => Promise<void>;
  get: (id: string) => Promise<UploadRecord | null>;
  list: () => Promise<UploadRecord[]>;
  remove: (id: string) => Promise<void>;
}

export const createMemoryStore = (): RecordStore => {
  const records = new Map<string, UploadRecord>();
  return {
    put: async (record) => {
      records.set(record.id, { ...record });
    },
    get: async (id) => records.get(id) ?? null,
    list: async () => [...records.values()],
    remove: async (id) => {
      records.delete(id);
    },
  };
};

/**
 * Scope a store so Records written under one owner are invisible to another.
 *
 * The intended use is the signed-in user's id: without this, the next person to
 * use a shared machine could Resume the previous person's Upload.
 */
export const scopeStore = (inner: RecordStore, owner: string): RecordStore => {
  const prefix = `${owner}::`;
  const scopedId = (id: string): string => `${prefix}${id}`;
  const strip = (record: UploadRecord): UploadRecord => ({
    ...record,
    id: record.id.slice(prefix.length),
  });

  return {
    put: (record) => inner.put({ ...record, id: scopedId(record.id) }),
    get: async (id) => {
      const record = await inner.get(scopedId(id));
      return record === null ? null : strip(record);
    },
    list: async () => (await inner.list()).filter((r) => r.id.startsWith(prefix)).map(strip),
    remove: (id) => inner.remove(scopedId(id)),
  };
};

/** Records older than this are treated as abandoned. */
export const DEFAULT_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const isStale = (record: UploadRecord, now: number, ttlMs: number): boolean =>
  now - record.updatedAt > ttlMs;

/**
 * Drop Records nobody came back for, and return the rest.
 *
 * Housekeeping, so it is best-effort per Record: a store that cannot drop one
 * stale Record must not stop the caller learning about the fresh ones.
 */
export const dropStaleRecords = async (
  store: RecordStore,
  now: number,
  ttlMs: number,
): Promise<UploadRecord[]> => {
  const records = await store.list();
  const fresh: UploadRecord[] = [];
  for (const record of records) {
    if (!isStale(record, now, ttlMs)) {
      fresh.push(record);
      continue;
    }
    await store.remove(record.id).catch((error: unknown) => {
      console.warn(
        "presigned-multipart-upload: the Record Store failed to drop a stale Record",
        error,
      );
    });
  }
  return fresh;
};
