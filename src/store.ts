import type { FileDescriptor } from "./types.js";

/** The persisted account of an Upload that has not finished. */
export interface UploadRecord {
  id: string;
  key: string;
  uploadId: string;
  file: FileDescriptor;
  partSize: number;
  partCount: number;
  /** Parts that landed, with the ETags finalising will need. */
  landed: { partNumber: number; eTag: string }[];
  updatedAt: number;
  /**
   * A durable reference to the file on the user's device, where the browser can
   * provide one. Structured-cloneable, which is why the browser store must be
   * IndexedDB — a File Handle cannot be put in localStorage.
   */
  handle: unknown | null;
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

export const isStale = (record: UploadRecord, now: number, ttlMs: number): boolean =>
  now - record.updatedAt > ttlMs;

const DB_NAME = "presigned-multipart-upload";
const STORE_NAME = "uploads";

const openDb = (dbName: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const promisify = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/**
 * The browser store. IndexedDB rather than localStorage because it is the only
 * web storage able to hold a File Handle, which Durable Resume depends on.
 */
export const createIndexedDbStore = (dbName = DB_NAME): RecordStore => {
  // Held open rather than reopened per write. A large file lands thousands of
  // Parts, and opening a connection for each one costs more than the write.
  let connection: Promise<IDBDatabase> | null = null;

  const connect = (): Promise<IDBDatabase> => {
    if (connection !== null) return connection;

    connection = openDb(dbName).then(
      (db) => {
        // A connection dropped underneath us — eviction, or another tab
        // upgrading — must not be handed out again.
        db.onclose = () => {
          connection = null;
        };
        db.onversionchange = () => {
          db.close();
          connection = null;
        };
        return db;
      },
      (error: unknown) => {
        connection = null;
        throw error;
      },
    );

    return connection;
  };

  const withStore = async <T>(
    mode: IDBTransactionMode,
    use: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await connect();
    return promisify(use(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)));
  };

  return {
    put: async (record) => {
      await withStore("readwrite", (store) => store.put(record));
    },
    get: async (id) => (await withStore("readonly", (store) => store.get(id))) ?? null,
    list: async () => (await withStore("readonly", (store) => store.getAll())) ?? [],
    remove: async (id) => {
      await withStore("readwrite", (store) => store.delete(id));
    },
  };
};

/**
 * The store used when the caller names none.
 *
 * IndexedDB wherever the browser has it, and nothing at all where it does not —
 * server-side rendering, a worker without storage. Durable Resume is then
 * simply unavailable, which is what naming no store used to give everybody.
 *
 * A default rather than an opt-in because the Record is small, expires, holds
 * no file bytes, and is the whole difference between surviving a reload and
 * not. Opting out is one word; opting in was a step most callers would only
 * discover having already lost an upload.
 */
let shared: RecordStore | null | undefined;

export const defaultStore = (): RecordStore | null => {
  // Built once and shared. The adapter holds its connection open on purpose,
  // so one per caller would be one connection per Upload for the page's life,
  // with no handle to close them by.
  if (shared === undefined) {
    shared = typeof indexedDB === "undefined" ? null : createIndexedDbStore();
  }
  return shared;
};
