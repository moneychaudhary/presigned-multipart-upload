import { describe, expect, it, vi } from "vitest";

import { createUploader, createMemoryStore, type RecordStore } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

/** A Record Store that works except for the calls named. */
const failingStore = (failing: Partial<Record<keyof RecordStore, boolean>>): RecordStore => {
  const inner = createMemoryStore();
  const boom = () => Promise.reject(new Error("QuotaExceededError"));
  return {
    put: (record) => (failing.put ? boom() : inner.put(record)),
    get: (id) => (failing.get ? boom() : inner.get(id)),
    list: () => (failing.list ? boom() : inner.list()),
    remove: (id) => (failing.remove ? boom() : inner.remove(id)),
  };
};

const build = (store: RecordStore, extra = {}) => {
  const platform = createFakePlatform();
  const transport = createFakeTransport();
  return {
    platform,
    transport,
    batch: createUploader({
      files: [makeFile(30 * KB)],
      transport,
      platform,
      store,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      ...extra,
    }),
  };
};

describe("a Record Store that rejects", () => {
  it("does not fail the Upload when writing a Record fails", async () => {
    const { batch, transport } = build(failingStore({ put: true }));

    const snapshot = await batch.start();

    // The store is documented as droppable. A store that throws must lose
    // Durable Resume, not the Upload.
    expect(snapshot.status).toBe("succeeded");
    expect(transport.state.completes).toHaveLength(1);
  });

  it("does not re-send a Part that already landed", async () => {
    const { batch, platform } = build(failingStore({ put: true }));

    await batch.start();

    // Three Parts, one Attempt each. A rejecting put classified as "retry"
    // would re-send Parts whose ETag is already in hand.
    expect(platform.state.calls).toHaveLength(3);
    expect(platform.state.calls.every((call) => call.attempt === 1)).toBe(true);
  });

  it("does not abandon sibling Uploads when removing a Record fails", async () => {
    const { batch } = build(failingStore({ remove: true }), {
      files: [makeFile(30 * KB, "a.mov"), makeFile(30 * KB, "b.mov")],
    });

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.uploads.map((upload) => upload.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("survives a store that cannot even be listed at construction", async () => {
    const rejections: unknown[] = [];
    const onRejection = (error: unknown) => rejections.push(error);
    process.on("unhandledRejection", onRejection);

    const { batch } = build(failingStore({ list: true }));
    const snapshot = await batch.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    process.off("unhandledRejection", onRejection);

    expect(snapshot.status).toBe("succeeded");
    expect(rejections).toHaveLength(0);
  });

  it("reports the failure rather than swallowing it in silence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { batch } = build(failingStore({ put: true }));
    await batch.start();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
