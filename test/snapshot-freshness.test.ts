import { describe, expect, it } from "vitest";

import { createUploader, type UploaderSnapshot } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";
import { flush } from "./fakes/async.js";

const build = (extra = {}) => {
  const platform = createFakePlatform(extra as never);
  const batch = createUploader({
    files: [makeFile(50 * KB)],
    transport: createFakeTransport(),
    platform,
    partSize: 10 * KB,
    provider: { minPartSize: 1 },
    concurrency: 1,
    maxRetries: 0,
  });
  return { batch, platform };
};

describe("the snapshot subscribers see", () => {
  it("changes identity exactly when something changed", async () => {
    const { batch } = build();
    const seen: UploaderSnapshot[] = [];
    batch.subscribe((snapshot) => seen.push(snapshot));

    await batch.start();

    expect(seen.length).toBeGreaterThan(1);
    // No two consecutive notifications may carry the same object: that would
    // mean a subscriber was woken for nothing.
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).not.toBe(seen[i - 1]);
  });

  it("is reused while nothing changes", () => {
    const { batch } = build();

    expect(batch.getSnapshot()).toBe(batch.getSnapshot());
  });

  it("reflects a Part that failed, not the state before it failed", async () => {
    const { batch } = build({ script: () => ({ kind: "network" }) });

    await batch.start();
    const part = batch.getSnapshot().file?.parts[0];

    expect(part?.status).toBe("failed");
    expect(part?.loaded).toBe(0);
  });

  it("reflects key and uploadId as soon as the Upload is Opened", async () => {
    const { batch, platform } = build({ script: () => ({ kind: "hang" }) });

    const run = batch.start();
    await flush();

    const upload = batch.getSnapshot().file;
    expect(upload?.key).toBe("uploads/clip.mov");
    expect(upload?.uploadId).toBe("s3-upload-0");

    await batch.cancel();
    await run;
    void platform;
  });
});
