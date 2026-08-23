import { describe, expect, it } from "vitest";

import { createUploader } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const build = (files: File[]) =>
  createUploader({
    files,
    transport: createFakeTransport(),
    platform: createFakePlatform(),
    partSize: 10 * KB,
    provider: { minPartSize: 1 },
  });

describe("the Batch of one", () => {
  it("puts the sole Upload on the snapshot, so no Adapter has to derive it", () => {
    const snapshot = build([makeFile(30 * KB, "clip.mov")]).getSnapshot();

    expect(snapshot.file?.file.name).toBe("clip.mov");
    expect(snapshot.file).toBe(snapshot.uploads[0]);
  });

  it("is null when the Batch holds anything other than exactly one", () => {
    expect(build([makeFile(30 * KB, "a.mov"), makeFile(30 * KB, "b.mov")]).getSnapshot().file)
      .toBeNull();
    expect(build([]).getSnapshot().file).toBeNull();
  });

  it("stays identity-stable while nothing changes", () => {
    const batch = build([makeFile(30 * KB)]);

    expect(batch.getSnapshot().file).toBe(batch.getSnapshot().file);
  });

  it("follows the Upload as it moves", async () => {
    const batch = build([makeFile(30 * KB)]);

    expect(batch.getSnapshot().file?.status).toBe("pending");
    const settled = await batch.start();
    expect(settled.file?.status).toBe("succeeded");
  });
});
