import { describe, expect, it } from "vitest";

import {
  createUploader,
  createMemoryStore,
  resumeUploader,
  listResumable,
  scopeStore,
  type RecordStore,
} from "../src/index.js";
import { fingerprintMismatch } from "../src/fingerprint.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform, fakeHandle, type FakePlatformOptions } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";
import { flush } from "./fakes/async.js";

/** Parts from 3 onward fail, leaving a half-finished Upload in the store. */
const failLate = (extra: FakePlatformOptions = {}) =>
  createFakePlatform({
    script: ({ partNumber }) => (partNumber >= 3 ? { kind: "network" } : { kind: "ok" }),
    ...extra,
  });

const interrupt = async (store: RecordStore, platformOptions: FakePlatformOptions = {}) => {
  const file = makeFile(50 * KB);
  const platform = failLate(platformOptions);
  const batch = createUploader({
    files: [{ file, handle: fakeHandle(file) }],
    transport: createFakeTransport(),
    platform,
    store,
    partSize: 10 * KB,
    provider: { minPartSize: 1 },
    maxRetries: 0,
    concurrency: 1,
  });
  await batch.start();
  return { file, platform };
};

describe("keeping an Upload Record", () => {
  it("writes the Record as Parts land, not only at the end", async () => {
    const store = createMemoryStore();
    const platform = createFakePlatform({
      script: ({ partNumber }) => (partNumber >= 3 ? { kind: "hang" } : { kind: "ok" }),
    });
    const batch = createUploader({
      files: [makeFile(50 * KB)],
      transport: createFakeTransport(),
      platform,
      store,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      concurrency: 1,
    });

    const run = batch.start();
    await flush();

    const mid = await store.get("upload-1");
    expect(mid?.landed.length).toBeGreaterThan(0);

    await batch.cancel();
    await run;
  });

  it("holds everything a Resume needs", async () => {
    const store = createMemoryStore();
    await interrupt(store);

    const record = await store.get("upload-1");
    expect(record).toMatchObject({
      key: "uploads/clip.mov",
      uploadId: "s3-upload-0",
      partSize: 10 * KB,
      partCount: 5,
    });
    expect(record!.landed).toEqual([
      { partNumber: 1, eTag: '"etag-1"' },
      { partNumber: 2, eTag: '"etag-2"' },
    ]);
    expect(record!.file.name).toBe("clip.mov");
  });

  it("removes the Record once the Upload succeeds", async () => {
    const store = createMemoryStore();
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport: createFakeTransport(),
      platform: createFakePlatform(),
      store,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    await batch.start();

    expect(await store.get("upload-1")).toBeNull();
  });

  it("removes the Record when the Upload is cancelled", async () => {
    const store = createMemoryStore();
    const platform = createFakePlatform({ script: () => ({ kind: "hang" }) });
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport: createFakeTransport(),
      platform,
      store,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const run = batch.start();
    await flush();
    await batch.cancel();
    await run;

    expect(await store.get("upload-1")).toBeNull();
  });

  it("uses an application-supplied store in place of the default", async () => {
    const inner = createMemoryStore();
    const puts: string[] = [];
    const store: RecordStore = { ...inner, put: async (r) => { puts.push(r.id); await inner.put(r); } };

    await interrupt(store);

    expect(puts).toContain("upload-1");
  });
});

describe("scoping Records to an owner", () => {
  it("hides one owner's Records from another", async () => {
    const shared = createMemoryStore();
    await interrupt(scopeStore(shared, "alice"));

    const platform = createFakePlatform();
    const alice = await listResumable({ store: scopeStore(shared, "alice"), platform });
    const bob = await listResumable({ store: scopeStore(shared, "bob"), platform });

    expect(alice).toHaveLength(1);
    expect(bob).toHaveLength(0);
  });
});

describe("finding interrupted Uploads on load", () => {
  it("lists what can be resumed, with how far it got", async () => {
    const store = createMemoryStore();
    await interrupt(store);

    const [found] = await listResumable({ store, platform: createFakePlatform() });

    expect(found).toMatchObject({
      id: "upload-1",
      landedParts: 2,
      totalParts: 5,
      key: "uploads/clip.mov",
    });
  });

  it("says the bytes come back on their own where handles are supported", async () => {
    const store = createMemoryStore();
    await interrupt(store, { handlesSupported: true });

    const [found] = await listResumable({
      store,
      platform: createFakePlatform({ handlesSupported: true }),
    });

    expect(found!.recovery).toBe("handle");
  });

  it("says the file must be re-selected where they are not", async () => {
    const store = createMemoryStore();
    await interrupt(store, { handlesSupported: false });

    const [found] = await listResumable({
      store,
      platform: createFakePlatform({ handlesSupported: false }),
    });

    expect(found!.recovery).toBe("reselect");
  });

  it("drops Records that have gone stale", async () => {
    const store = createMemoryStore();
    await interrupt(store);

    const later = createFakePlatform({ now: 30 * 24 * 60 * 60 * 1000 });
    const found = await listResumable({ store, platform: later });

    expect(found).toHaveLength(0);
    expect(await store.get("upload-1")).toBeNull();
  });
});

describe("resuming across a page session, via a File Handle", () => {
  it("continues with no re-selection at all", async () => {
    const store = createMemoryStore();
    await interrupt(store, { handlesSupported: true });

    const transport = createFakeTransport();
    const batch = await resumeUploader({
      store,
      resume: [{ id: "upload-1" }],
      transport,
      platform: createFakePlatform({ handlesSupported: true }),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const snapshot = await batch.resume();

    expect(snapshot.uploads[0]!.status).toBe("succeeded");
    expect(transport.state.opens[0]!.resumeFrom).toEqual({
      key: "uploads/clip.mov",
      uploadId: "s3-upload-0",
    });
  });

  it("sends only the Parts that never landed", async () => {
    const store = createMemoryStore();
    await interrupt(store, { handlesSupported: true });

    const platform = createFakePlatform({ handlesSupported: true });
    const batch = await resumeUploader({
      store,
      resume: [{ id: "upload-1" }],
      transport: createFakeTransport(),
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    await batch.resume();

    expect(platform.state.calls.map((call) => call.partNumber).sort()).toEqual([3, 4, 5]);
  });

  it("carries the earlier ETags into finalising", async () => {
    const store = createMemoryStore();
    await interrupt(store, { handlesSupported: true });

    const transport = createFakeTransport();
    const batch = await resumeUploader({
      store,
      resume: [{ id: "upload-1" }],
      transport,
      platform: createFakePlatform({ handlesSupported: true }),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    await batch.resume();

    expect(transport.state.completes[0]!.parts.map((p) => p.partNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it("falls back to needing the file when permission is refused", async () => {
    const store = createMemoryStore();
    await interrupt(store, { handlesSupported: true });

    await expect(
      resumeUploader({
        store,
        resume: [{ id: "upload-1" }],
        transport: createFakeTransport(),
        platform: createFakePlatform({ handlesSupported: true, permissionGranted: false }),
        partSize: 10 * KB,
        provider: { minPartSize: 1 },
      }),
    ).rejects.toMatchObject({ code: "FILE_REQUIRED" });
  });
});

describe("resuming across a page session, by re-selecting the file", () => {
  it("asks for the file where handles are unsupported", async () => {
    const store = createMemoryStore();
    await interrupt(store, { handlesSupported: false });

    await expect(
      resumeUploader({
        store,
        resume: [{ id: "upload-1" }],
        transport: createFakeTransport(),
        platform: createFakePlatform({ handlesSupported: false }),
        partSize: 10 * KB,
        provider: { minPartSize: 1 },
      }),
    ).rejects.toMatchObject({ code: "FILE_REQUIRED" });
  });

  it("continues when the re-selected file matches", async () => {
    const store = createMemoryStore();
    const { file } = await interrupt(store, { handlesSupported: false });

    const batch = await resumeUploader({
      store,
      resume: [{ id: "upload-1", file }],
      transport: createFakeTransport(),
      platform: createFakePlatform({ handlesSupported: false }),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    expect((await batch.resume()).uploads[0]!.status).toBe("succeeded");
  });

  it("refuses a different name, and sends nothing", async () => {
    const store = createMemoryStore();
    await interrupt(store, { handlesSupported: false });
    const platform = createFakePlatform({ handlesSupported: false });

    await expect(
      resumeUploader({
        store,
        resume: [{ id: "upload-1", file: makeFile(50 * KB, "other.mov") }],
        transport: createFakeTransport(),
        platform,
        partSize: 10 * KB,
        provider: { minPartSize: 1 },
      }),
    ).rejects.toMatchObject({ code: "FINGERPRINT_MISMATCH" });

    expect(platform.state.calls).toHaveLength(0);
  });

  it("refuses a different size", async () => {
    const store = createMemoryStore();
    await interrupt(store, { handlesSupported: false });

    await expect(
      resumeUploader({
        store,
        resume: [{ id: "upload-1", file: makeFile(60 * KB) }],
        transport: createFakeTransport(),
        platform: createFakePlatform({ handlesSupported: false }),
        partSize: 10 * KB,
        provider: { minPartSize: 1 },
      }),
    ).rejects.toMatchObject({ code: "FINGERPRINT_MISMATCH" });
  });

  it("refuses a different last-modified time", async () => {
    const store = createMemoryStore();
    await interrupt(store, { handlesSupported: false });

    const edited = new File([new Uint8Array(50 * KB)], "clip.mov", {
      type: "video/quicktime",
      lastModified: 1_800_000_000_000,
    });

    await expect(
      resumeUploader({
        store,
        resume: [{ id: "upload-1", file: edited }],
        transport: createFakeTransport(),
        platform: createFakePlatform({ handlesSupported: false }),
        partSize: 10 * KB,
        provider: { minPartSize: 1 },
      }),
    ).rejects.toMatchObject({ code: "FINGERPRINT_MISMATCH" });
  });

  it("can be relaxed by configuration", async () => {
    const store = createMemoryStore();
    await interrupt(store, { handlesSupported: false });

    const batch = await resumeUploader({
      store,
      resume: [{ id: "upload-1", file: makeFile(50 * KB, "renamed.mov") }],
      transport: createFakeTransport(),
      platform: createFakePlatform({ handlesSupported: false }),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      fingerprint: { name: false },
    });

    expect((await batch.resume()).uploads[0]!.status).toBe("succeeded");
  });

  it("rejects an id with no Record behind it", async () => {
    await expect(
      resumeUploader({
        store: createMemoryStore(),
        resume: [{ id: "ghost" }],
        transport: createFakeTransport(),
        platform: createFakePlatform(),
      }),
    ).rejects.toMatchObject({ code: "NOT_RESUMABLE" });
  });
});

describe("comparing fingerprints directly", () => {
  const base = { name: "a.mov", size: 10, type: "video/quicktime", lastModified: 1 };

  it("reports no mismatch for identical descriptors", () => {
    expect(fingerprintMismatch(base, { ...base })).toBeNull();
  });

  it("names the field that differs", () => {
    expect(fingerprintMismatch(base, { ...base, size: 11 })).toBe("size");
    expect(fingerprintMismatch(base, { ...base, name: "b.mov" })).toBe("name");
    expect(fingerprintMismatch(base, { ...base, lastModified: 2 })).toBe("lastModified");
  });

  it("skips fields turned off", () => {
    expect(fingerprintMismatch(base, { ...base, name: "b.mov" }, { name: false })).toBeNull();
  });
});
