import { describe, expect, it } from "vitest";

import { createUploader, createMemoryStore, listResumable } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform, fakeHandle } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

/** One source of Upload ids, as a browser has one, shared by both Batches. */
const identities = () =>
  createFakePlatform({
    script: ({ partNumber }) => (partNumber >= 2 ? { kind: "network" } : { kind: "ok" }),
  });

/** A Batch of one that fails part-way, leaving an Upload Record behind. */
const interruptedBatch = (
  name: string,
  store: ReturnType<typeof createMemoryStore>,
  platform: ReturnType<typeof createFakePlatform>,
) => {
  const file = makeFile(30 * KB, name);
  return createUploader({
    files: [{ file, handle: fakeHandle(file) }],
    transport: createFakeTransport(),
    platform,
    store,
    partSize: 10 * KB,
    provider: { minPartSize: 1 },
    maxRetries: 0,
    concurrency: 1,
  });
};

describe("Uploads sharing a Record Store", () => {
  it("keeps a Record for each interrupted Upload across separate Batches", async () => {
    const store = createMemoryStore();
    const platform = identities();

    await interruptedBatch("first.mov", store, platform).start();
    await interruptedBatch("second.mov", store, platform).start();

    const resumable = await listResumable({ store, platform: createFakePlatform() });
    const names = resumable.map((upload) => upload.file.name).sort();

    // Positional ids would make both Batches mint the same one, and the second
    // Record would silently overwrite the first — losing the only half of
    // Durable Resume the library can always keep.
    expect(names).toEqual(["first.mov", "second.mov"]);
  });

  it("gives two Uploads of the same file distinct identities", async () => {
    const store = createMemoryStore();
    const platform = identities();

    await interruptedBatch("clip.mov", store, platform).start();
    await interruptedBatch("clip.mov", store, platform).start();

    const resumable = await listResumable({ store, platform: createFakePlatform() });
    const ids = new Set(resumable.map((upload) => upload.id));

    expect(ids.size).toBe(2);
  });
});
