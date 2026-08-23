import { describe, expect, it } from "vitest";

import { createUploader } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";
import { flush } from "./fakes/async.js";

describe("the Connection Budget during backoff", () => {
  it("does not let Parts waiting out a backoff block Parts ready to send", async () => {
    const transport = createFakeTransport();
    // Parts 1 and 2 fail once and then need a backoff; 3, 4 and 5 are ready to
    // go. With a Budget of two, the two sleeping Parts used to hold both slots.
    const platform = createFakePlatform({
      script: ({ partNumber, attempt }) =>
        partNumber <= 2 && attempt === 1 ? { kind: "network" } : { kind: "ok" },
    });

    const batch = createUploader({
      files: [makeFile(50 * KB)],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      concurrency: 2,
      retryBaseMs: 1000,
    });

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(platform.state.sleeps.length).toBeGreaterThan(0);
  });

  it("still never exceeds the Budget while Parts are actually sending", async () => {
    const platform = createFakePlatform({
      script: ({ attempt }) => (attempt === 1 ? { kind: "network" } : { kind: "ok" }),
    });

    const batch = createUploader({
      files: [makeFile(80 * KB, "a.mov"), makeFile(80 * KB, "b.mov")],
      transport: createFakeTransport(),
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      concurrency: 3,
    });

    await batch.start();

    expect(platform.state.peakInFlight).toBeLessThanOrEqual(3);
  });

  it("holds no slot at all while every Part is asleep", async () => {
    const platform = createFakePlatform({
      script: ({ attempt }) => (attempt === 1 ? { kind: "network" } : { kind: "hang" }),
    });

    const batch = createUploader({
      files: [makeFile(30 * KB)],
      transport: createFakeTransport(),
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      concurrency: 1,
    });

    const run = batch.start();
    await flush();

    // Three Parts, a Budget of one, every first Attempt failing: if the slot
    // were held across the sleep, only one Part would ever have been tried.
    expect(new Set(platform.state.calls.map((call) => call.partNumber)).size).toBe(3);

    await batch.cancel();
    await run;
  });
});
