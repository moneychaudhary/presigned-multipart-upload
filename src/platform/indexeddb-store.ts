import type { RecordStore } from "../store.js";

/**
 * The browser's Record Store, on IndexedDB.
 *
 * Lives beside the browser Platform because, like it, this is the outside
 * world: the Core never touches IndexedDB, only the RecordStore interface. It
 * reaches this file solely through `defaultStore()`, which answers null
 * wherever IndexedDB does not exist — Node, SSR, the test suite — so the Core
 * stays deterministic everywhere a test runs.
 */

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
