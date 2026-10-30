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
    limits: { minPartSize: 1 },
  });

describe("the Batch of one", () => {
  it("puts the sole Upload on the snapshot, so no Adapter has to derive it", () => {
    const snapshot = build([makeFile(30 * KB, "clip.mov")]).getSnapshot();

    expect(snapshot.upload?.file.name).toBe("clip.mov");
    expect(snapshot.upload).toBe(snapshot.uploads[0]);
  });

  it("is null when the Batch holds anything other than exactly one", () => {
    expect(
      build([makeFile(30 * KB, "a.mov"), makeFile(30 * KB, "b.mov")]).getSnapshot().upload,
    ).toBeNull();
    expect(build([]).getSnapshot().upload).toBeNull();
  });

  it("stays identity-stable while nothing changes", () => {
    const batch = build([makeFile(30 * KB)]);

    expect(batch.getSnapshot().upload).toBe(batch.getSnapshot().upload);
  });

  it("follows the Upload as it moves", async () => {
    const batch = build([makeFile(30 * KB)]);

    expect(batch.getSnapshot().upload?.status).toBe("pending");
    const settled = await batch.start();
    expect(settled.upload?.status).toBe("succeeded");
  });
});
