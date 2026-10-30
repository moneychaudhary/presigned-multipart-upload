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
  limits: { minPartSize: 1 },
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
      platform.releaseHung(call.id, call.partNumber, { kind: "ok" });
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
      limits: { minPartSize: 1 },
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
      files: [makeFile(80 * KB, "a.mov"), makeFile(80 * KB, "b.mov"), makeFile(80 * KB, "c.mov")],
      transport,
      platform,
      partSize: 10 * KB,
      limits: { minPartSize: 1 },
      concurrency: 3,
      retry: { max: 4 },
    });

    await batch.start();

    expect(platform.state.peakInFlight).toBeLessThanOrEqual(3);
  });
});

describe("sharing the Connection Budget between Uploads", () => {
  it("does not make a small file wait behind every Part of a large one", async () => {
    const platform = createFakePlatform();
    const batch = createUploader({
      files: [makeFile(100 * KB, "large.mov"), makeFile(20 * KB, "small.mov")],
      ...opts(platform, { concurrency: 2 }),
    });

    await batch.start();

    // Ten Parts of the large file were queued before the small one Opened. A
    // single first-come queue sends all ten first; taking turns does not.
    const firstSmall = platform.state.calls.findIndex((call) => call.id === "upload-2");
    expect(firstSmall).toBeLessThan(4);
  });

  it("takes turns between Uploads while all of them have Parts waiting", async () => {
    const platform = createFakePlatform();
    const batch = createUploader({
      files: [makeFile(60 * KB, "a.mov"), makeFile(60 * KB, "b.mov")],
      ...opts(platform, { concurrency: 1 }),
    });

    await batch.start();

    // After the first send, neither Upload goes twice running while the other waits.
    const order = platform.state.calls.map((call) => call.id).slice(1, 9);
    for (let i = 1; i < order.length; i += 1) expect(order[i]).not.toBe(order[i - 1]);
  });
});

describe("a Part waiting for a slot when its Upload is stopped", () => {
  it("never makes an Attempt once it gets the slot", async () => {
    // A Platform need not check the signal before sending, so the Core must
    // not call it for a stopped Upload at all.
    const base = createFakePlatform({ script: () => ({ kind: "hang" }) });
    const sentAfterPause: string[] = [];
    let paused = false;
    const platform = {
      ...base,
      sendPart: (args: Parameters<typeof base.sendPart>[0]) => {
        if (paused && args.id === "upload-1") sentAfterPause.push(`${args.id}:${args.partNumber}`);
        return base.sendPart(args);
      },
    };
    const batch = createUploader({
      files: [makeFile(50 * KB, "a.mov"), makeFile(50 * KB, "b.mov")],
      ...opts(base, { concurrency: 2, platform }),
    });

    const run = batch.start();
    await flush();
    paused = true;
    await batch.pause("upload-1");
    // Free upload-2's slots, so upload-1's queued Parts are handed them.
    for (const call of [...base.state.calls]) {
      if (call.id === "upload-2") base.releaseHung(call.id, call.partNumber, { kind: "ok" });
    }
    await flush();
    await batch.cancel();
    await run;

    expect(sentAfterPause).toEqual([]);
  });
});
