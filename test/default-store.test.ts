// @vitest-environment happy-dom
import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import { createUploader, listResumable, resumeUploader } from "../src/index.js";
import type { RecordStore } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

/**
 * Durable Resume is the library's headline promise, and it used to stay off
 * until the caller named a store — a default nobody could see failing. The
 * browser store takes no configuration, so asking for it was pure ceremony.
 */
describe("the Record Store nobody configured", () => {
  /** Part 3 never lands, so the Upload ends unfinished and keeps its Record. */
  const build = (store?: RecordStore | null) =>
    createUploader({
      files: [makeFile(25 * KB)],
      transport: createFakeTransport(),
      platform: createFakePlatform({
        now: Date.now(),
        script: ({ partNumber }) => (partNumber === 3 ? { kind: "status", status: 404 } : { kind: "ok" }),
      }),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      maxRetries: 0,
      ...(store === undefined ? {} : { store }),
    });

  it("keeps Records in IndexedDB without being asked", async () => {
    const settled = await build().start();
    expect(settled.status).toBe("failed");

    const found = await listResumable();
    expect(found.map((upload) => upload.file.name)).toContain("clip.mov");
  });

  it("keeps none when told to keep none", async () => {
    const before = (await listResumable()).length;
    await build(null).start();

    // Nothing reached the default store, and nothing is offered from no store.
    expect(await listResumable()).toHaveLength(before);
    expect(await listResumable({ store: null })).toEqual([]);
  });

  it("lets a reload pick the Upload back up with no store named anywhere", async () => {
    await build().start();

    const interrupted = (await listResumable()).at(-1)!;
    const revived = await resumeUploader({
      transport: createFakeTransport(),
      platform: createFakePlatform({ now: Date.now() }),
      resume: [{ id: interrupted.id, file: makeFile(25 * KB) }],
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const settled = await revived.resume();
    expect(settled.status).toBe("succeeded");
    // Only the Part that never landed was sent again.
    expect(settled.uploads[0]!.parts.filter((part) => part.status === "landed")).toHaveLength(3);
  });
});
