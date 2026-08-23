// @vitest-environment happy-dom
import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import { createIndexedDbStore, scopeStore, type UploadRecord } from "../src/index.js";

let n = 0;
let dbName = "";
/** A fresh database per test, so one test's Records cannot reach another's. */
const freshStore = () => {
  n += 1;
  dbName = `pmu-test-${n}`;
  return createIndexedDbStore(dbName);
};

const record = (id: string, over: Partial<UploadRecord> = {}): UploadRecord => ({
  id,
  key: `uploads/${id}.mov`,
  uploadId: `s3-${id}`,
  file: { name: `${id}.mov`, size: 30720, type: "video/quicktime", lastModified: 1700000000000 },
  partSize: 10240,
  partCount: 3,
  landed: [{ partNumber: 1, eTag: '"etag-1"' }],
  updatedAt: 0,
  handle: null,
  ...over,
});

describe("the IndexedDB Record Store", () => {
  it("gives back what was put in", async () => {
    const store = freshStore();
    await store.put(record("a"));

    expect(await store.get("a")).toEqual(record("a"));
  });

  it("answers null for a Record that was never written", async () => {
    expect(await freshStore().get("missing")).toBeNull();
  });

  it("overwrites a Record with the same id rather than duplicating it", async () => {
    const store = freshStore();
    await store.put(record("a"));
    await store.put(record("a", { partCount: 9 }));

    expect((await store.list())).toHaveLength(1);
    expect((await store.get("a"))?.partCount).toBe(9);
  });

  it("removes a Record, and does not mind removing one twice", async () => {
    const store = freshStore();
    await store.put(record("a"));

    await store.remove("a");
    await store.remove("a");

    expect(await store.get("a")).toBeNull();
  });

  it("keeps a File Handle across the structured clone, which is why IndexedDB was chosen", async () => {
    const store = freshStore();
    const handle = { kind: "file", name: "clip.mov", nested: { depth: 2 } };

    await store.put(record("a", { handle }));
    const back = await store.get("a");

    // localStorage would have stringified this into uselessness.
    expect(back?.handle).toEqual(handle);
    expect(back?.handle).not.toBe(handle);
  });

  it("survives the connection being closed underneath it", async () => {
    const store = freshStore();
    await store.put(record("a"));

    // Mirrors an eviction or another tab upgrading the database: the cached
    // connection must be dropped and reopened rather than reused dead.
    const open = indexedDB.open(dbName);
    await new Promise((resolve) => {
      open.onsuccess = () => resolve(null);
    });
    open.result.close();

    await store.put(record("b"));
    expect(await store.list()).toHaveLength(2);
  });

  it("holds many Records without them interfering", async () => {
    const store = freshStore();
    await Promise.all(["a", "b", "c", "d"].map((id) => store.put(record(id))));

    const ids = (await store.list()).map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });
});

describe("scoping a real store to one owner", () => {
  it("hides one owner's Records from another", async () => {
    const shared = freshStore();
    const mine = scopeStore(shared, "user-1");
    const theirs = scopeStore(shared, "user-2");

    await mine.put(record("a"));
    await theirs.put(record("b"));

    expect((await mine.list()).map((r) => r.id)).toEqual(["a"]);
    expect((await theirs.list()).map((r) => r.id)).toEqual(["b"]);
    expect(await mine.get("b")).toBeNull();
  });
});
