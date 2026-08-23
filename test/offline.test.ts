import { describe, expect, it } from "vitest";

import { createUploader } from "../src/index.js";
import { flush } from "./fakes/async.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const build = (platform: ReturnType<typeof createFakePlatform>, tuning = {}) =>
  createUploader({
    files: [makeFile(25 * KB)],
    transport: createFakeTransport(),
    platform,
    partSize: 10 * KB,
    provider: { minPartSize: 1 },
    concurrency: 1,
    ...tuning,
  });

describe("losing connectivity", () => {
  it("parks before spending an Attempt when already offline", async () => {
    const platform = createFakePlatform({ online: false });
    const batch = build(platform);

    const run = batch.start();
    await flush();

    // Nothing was even attempted — the Core is waiting, not failing.
    expect(platform.state.calls).toHaveLength(0);

    platform.goOnline();
    const snapshot = await run;

    expect(snapshot.status).toBe("succeeded");
  });

  it("parks rather than Retrying when the connection drops mid-Attempt", async () => {
    const platform = createFakePlatform({
      script: ({ attempt }) => (attempt === 1 ? { kind: "network" } : { kind: "ok" }),
    });
    const batch = build(platform);

    // The first send fails and the browser reports itself offline immediately after.
    platform.goOffline();
    const run = batch.start();
    await flush();

    platform.goOnline();
    const snapshot = await run;

    expect(snapshot.status).toBe("succeeded");
  });

  it("does not spend the Retry budget while disconnected", async () => {
    const platform = createFakePlatform({ online: false });
    const batch = build(platform, { maxRetries: 1 });

    const run = batch.start();
    await flush();
    await flush();

    platform.goOnline();
    const snapshot = await run;

    // A budget of one Retry survived the wait because waiting cost nothing.
    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.uploads[0]!.parts.every((part) => part.attempts === 1)).toBe(true);
    expect(platform.state.sleeps).toHaveLength(0);
  });

  it("wakes and finishes when connectivity returns", async () => {
    const platform = createFakePlatform({ online: false });
    const transport = createFakeTransport();
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const run = batch.start();
    await flush();
    expect(transport.state.completes).toHaveLength(0);

    platform.goOnline();
    await run;

    expect(transport.state.completes).toHaveLength(1);
  });

  it("fails fast instead of parking when offline waiting is turned off", async () => {
    const platform = createFakePlatform({
      online: false,
      script: () => ({ kind: "network" }),
    });
    const batch = build(platform, { waitWhileOffline: false, maxRetries: 0 });

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.status).toBe("failed");
    expect(snapshot.uploads[0]!.error?.code).toBe("RETRIES_EXHAUSTED");
  });
});
