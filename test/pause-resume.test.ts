import { describe, expect, it, vi } from "vitest";

import { createUploader } from "../src/index.js";
import { flush } from "./fakes/async.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

/** Part 3 onwards hangs, so the Upload can be caught mid-flight with 1–2 landed. */
const hangOnThird = () =>
  createFakePlatform({
    script: ({ partNumber }) => (partNumber >= 3 ? { kind: "hang" } : { kind: "ok" }),
  });

/**
 * Hangs from Part 3 until the test opens the gate.
 *
 * Keyed on a phase rather than the Attempt number, because a Part that was
 * still queued when the Pause landed has made no Attempt at all — on Resume it
 * would be on its first, and an attempt-keyed script would hang it forever.
 */
const gatedPlatform = () => {
  const phase = { open: false };
  const platform = createFakePlatform({
    script: ({ partNumber }) =>
      partNumber >= 3 && !phase.open ? { kind: "hang" } : { kind: "ok" },
  });
  return { platform, phase };
};

const build = (platform: ReturnType<typeof createFakePlatform>, transport = createFakeTransport()) => ({
  transport,
  batch: createUploader({
    files: [makeFile(50 * KB)],
    transport,
    platform,
    partSize: 10 * KB,
    provider: { minPartSize: 1 },
    concurrency: 2,
  }),
});

describe("pausing", () => {
  it("halts without tearing the Upload down", async () => {
    const platform = hangOnThird();
    const { batch, transport } = build(platform);

    const run = batch.start();
    await flush();
    const snapshot = await batch.pause();
    await run;

    expect(snapshot.uploads[0]!.status).toBe("paused");
    expect(transport.state.aborts).toHaveLength(0);
  });

  it("keeps the Parts that already landed", async () => {
    const platform = hangOnThird();
    const { batch } = build(platform);

    const run = batch.start();
    await flush();
    await batch.pause();
    await run;

    const landed = batch.getSnapshot().uploads[0]!.parts.filter((p) => p.status === "landed");
    expect(landed.length).toBeGreaterThan(0);
  });

  it("marks the Upload resumable", async () => {
    const platform = hangOnThird();
    const { batch } = build(platform);

    const run = batch.start();
    await flush();
    await batch.pause();
    await run;

    expect(batch.getSnapshot().uploads[0]!.resumable).toBe(true);
  });

  it("announces the pause", async () => {
    const platform = hangOnThird();
    const { batch } = build(platform);
    const paused = vi.fn();
    batch.on("upload:paused", paused);

    const run = batch.start();
    await flush();
    await batch.pause();
    await run;

    expect(paused).toHaveBeenCalledWith({ id: "upload-1" });
  });

  it("is idempotent", async () => {
    const platform = hangOnThird();
    const { batch } = build(platform);

    const run = batch.start();
    await flush();
    await batch.pause();
    await batch.pause();
    await run;

    expect(batch.getSnapshot().uploads[0]!.status).toBe("paused");
  });
});

describe("resuming after a pause", () => {
  it("continues and completes", async () => {
    const { platform, phase } = gatedPlatform();
    const { batch, transport } = build(platform);

    const run = batch.start();
    await flush();
    await batch.pause();
    await run;

    phase.open = true;
    const snapshot = await batch.resume();

    expect(snapshot.uploads[0]!.status).toBe("succeeded");
    expect(transport.state.completes).toHaveLength(1);
  });

  it("does not re-send Parts that already landed", async () => {
    const { platform, phase } = gatedPlatform();
    const { batch } = build(platform);

    const run = batch.start();
    await flush();
    await batch.pause();
    await run;

    const landedBefore = batch
      .getSnapshot()
      .uploads[0]!.parts.filter((p) => p.status === "landed")
      .map((p) => p.partNumber);

    expect(landedBefore).toContain(1);

    const callsBefore = platform.state.calls.length;
    phase.open = true;
    await batch.resume();

    const resent = platform.state.calls
      .slice(callsBefore)
      .map((call) => call.partNumber)
      .filter((partNumber) => landedBefore.includes(partNumber));

    expect(resent).toHaveLength(0);
  });

  it("Opens again, telling the Transport this is a Resume, and uses the fresh urls", async () => {
    const { platform, phase } = gatedPlatform();
    const { batch, transport } = build(platform);

    const run = batch.start();
    await flush();
    await batch.pause();
    await run;

    const callsBefore = platform.state.calls.length;
    phase.open = true;
    await batch.resume();

    expect(transport.state.opens).toHaveLength(2);
    expect(transport.state.opens[1]!.resumeFrom).toEqual({
      key: "uploads/clip.mov",
      uploadId: "s3-upload-0",
    });
    // Every send after the Resume used a url minted by the second Opening.
    expect(
      platform.state.calls.slice(callsBefore).every((call) => call.url.includes("open1")),
    ).toBe(true);
  });

  it("gives unfinished Parts a fresh Retry budget", async () => {
    const { platform, phase } = gatedPlatform();
    const { batch } = build(platform);

    const run = batch.start();
    await flush();
    await batch.pause();
    await run;

    phase.open = true;
    await batch.resume();
    const parts = batch.getSnapshot().uploads[0]!.parts;

    // Part 3 was abandoned mid-Attempt; after the Resume its counter shows only
    // the Attempts the Resume itself made.
    expect(parts[2]!.attempts).toBe(1);
    expect(parts.every((part) => part.status === "landed")).toBe(true);
  });

  it("is a no-op on an Upload that already succeeded", async () => {
    const transport = createFakeTransport();
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport,
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    await batch.start();
    const snapshot = await batch.resume("upload-1");

    expect(snapshot.uploads[0]!.status).toBe("succeeded");
    expect(transport.state.opens).toHaveLength(1);
  });

  it("is a no-op when nothing is resumable", async () => {
    const transport = createFakeTransport();
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport,
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    await batch.start();
    await batch.resume();

    expect(transport.state.opens).toHaveLength(1);
  });

  it("rejects an unknown Upload id", async () => {
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport: createFakeTransport(),
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    await expect(batch.resume("nope")).rejects.toMatchObject({ code: "NOT_RESUMABLE" });
  });
});

describe("pausing then cancelling", () => {
  it("is terminal", async () => {
    const platform = hangOnThird();
    const { batch, transport } = build(platform);

    const run = batch.start();
    await flush();
    await batch.pause();
    await run;
    const snapshot = await batch.cancel();

    expect(snapshot.uploads[0]!.status).toBe("cancelled");
    expect(transport.state.aborts).toHaveLength(1);
    await expect(batch.resume("upload-1")).rejects.toMatchObject({ code: "NOT_RESUMABLE" });
  });
});
