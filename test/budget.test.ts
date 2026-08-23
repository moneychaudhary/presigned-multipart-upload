import { describe, expect, it } from "vitest";

import { createUploader } from "../src/index.js";
import { flush } from "./fakes/async.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const opts = (platform: ReturnType<typeof createFakePlatform>, extra = {}) => ({
  transport: createFakeTransport(),
  platform,
  partSize: 10 * KB,
  provider: { minPartSize: 1 },
  ...extra,
});

describe("enforcing the Connection Budget", () => {
  it("never has more Parts in flight than the budget allows", async () => {
    const platform = createFakePlatform({ script: () => ({ kind: "hang" }) });
    const batch = createUploader({
      files: [makeFile(100 * KB)],
      ...opts(platform, { concurrency: 3 }),
    });

    const run = batch.start();
    await flush();

    expect(platform.state.peakInFlight).toBe(3);
    expect(platform.state.calls).toHaveLength(3);

    for (const call of [...platform.state.calls]) {
      platform.releaseHung(call.uploadId, call.partNumber, { kind: "ok" });
    }
    await flush();

    await batch.cancel();
    await run;
  });

  it("caps Parts in flight across the whole Batch, not per Upload", async () => {
    const platform = createFakePlatform({ script: () => ({ kind: "hang" }) });
    const batch = createUploader({
      files: [makeFile(50 * KB, "a.mov"), makeFile(50 * KB, "b.mov"), makeFile(50 * KB, "c.mov")],
      ...opts(platform, { concurrency: 4 }),
    });

    const run = batch.start();
    await flush();

    expect(platform.state.peakInFlight).toBe(4);

    await batch.cancel();
    await run;
  });

  it("serialises Parts strictly when the budget is one", async () => {
    const platform = createFakePlatform();
    const batch = createUploader({
      files: [makeFile(50 * KB)],
      ...opts(platform, { concurrency: 1 }),
    });

    await batch.start();

    expect(platform.state.peakInFlight).toBe(1);
    expect(platform.state.calls.map((call) => call.partNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it("uploads several files concurrently, each completing independently", async () => {
    const platform = createFakePlatform();
    const transport = createFakeTransport();
    const batch = createUploader({
      files: [makeFile(25 * KB, "a.mov"), makeFile(25 * KB, "b.mov")],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(transport.state.opens).toHaveLength(2);
    expect(transport.state.completes).toHaveLength(2);
    expect(snapshot.uploads.every((upload) => upload.status === "succeeded")).toBe(true);
  });

  it("aggregates Batch progress across its Uploads", async () => {
    const platform = createFakePlatform();
    const batch = createUploader({
      files: [makeFile(25 * KB, "a.mov"), makeFile(15 * KB, "b.mov")],
      ...opts(platform),
    });

    const snapshot = await batch.start();

    expect(snapshot.progress.total).toBe(40 * KB);
    expect(snapshot.progress.loaded).toBe(40 * KB);
    expect(snapshot.progress.percent).toBe(100);
  });
});

describe("the Connection Budget under a release/acquire race", () => {
  it("never exceeds the limit when a slot frees while others are queueing", async () => {
    const platform = createFakePlatform({
      // Every Part yields, so releases and acquires genuinely interleave.
      script: ({ partNumber }) => (partNumber % 2 === 0 ? { kind: "network" } : { kind: "ok" }),
    });
    const transport = createFakeTransport();

    const batch = createUploader({
      files: [
        makeFile(80 * KB, "a.mov"),
        makeFile(80 * KB, "b.mov"),
        makeFile(80 * KB, "c.mov"),
      ],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      concurrency: 3,
      maxRetries: 4,
    });

    await batch.start();

    expect(platform.state.peakInFlight).toBeLessThanOrEqual(3);
  });
});
