import { describe, expect, it } from "vitest";

import { createUploader } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

/** Parts from 3 onward fail until the test opens the gate. */
const gated = () => {
  const phase = { open: false };
  const platform = createFakePlatform({
    script: ({ partNumber }) =>
      partNumber >= 3 && !phase.open ? { kind: "network" } : { kind: "ok" },
  });
  return { platform, phase };
};

const build = (platform: ReturnType<typeof createFakePlatform>, extra = {}) => {
  const transport = createFakeTransport();
  return {
    transport,
    batch: createUploader({
      files: [makeFile(50 * KB)],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      maxRetries: 1,
      concurrency: 1,
      ...extra,
    }),
  };
};

describe("when Retries run out", () => {
  it("marks the Upload failed with a distinct code", async () => {
    const { platform } = gated();
    const { batch } = build(platform);

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.status).toBe("failed");
    expect(snapshot.uploads[0]!.error?.code).toBe("RETRIES_EXHAUSTED");
  });

  it("does NOT tear the Upload down — that is what makes Resume possible", async () => {
    const { platform } = gated();
    const { batch, transport } = build(platform);

    await batch.start();

    expect(transport.state.aborts).toHaveLength(0);
  });

  it("reports the Upload as resumable", async () => {
    const { platform } = gated();
    const { batch } = build(platform);

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.resumable).toBe(true);
  });

  it("keeps the Parts that landed before the failure", async () => {
    const { platform } = gated();
    const { batch } = build(platform);

    const snapshot = await batch.start();
    const landed = snapshot.uploads[0]!.parts.filter((part) => part.status === "landed");

    expect(landed.map((part) => part.partNumber)).toEqual([1, 2]);
    expect(landed.every((part) => part.eTag !== null)).toBe(true);
  });

  it("fails only the Upload that ran out, not its siblings", async () => {
    const platform = createFakePlatform({
      script: ({ uploadId }) => (uploadId === "upload-1" ? { kind: "network" } : { kind: "ok" }),
    });
    const batch = createUploader({
      files: [makeFile(25 * KB, "a.mov"), makeFile(25 * KB, "b.mov")],
      transport: createFakeTransport(),
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      maxRetries: 0,
    });

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.status).toBe("failed");
    expect(snapshot.uploads[1]!.status).toBe("succeeded");
    expect(snapshot.status).toBe("failed");
  });
});

describe("resuming a failed Upload", () => {
  it("sends only the Parts that never landed", async () => {
    const { platform, phase } = gated();
    const { batch } = build(platform);

    await batch.start();
    const callsBefore = platform.state.calls.length;

    phase.open = true;
    const snapshot = await batch.resume();

    expect(snapshot.uploads[0]!.status).toBe("succeeded");
    const afterResume = platform.state.calls.slice(callsBefore).map((call) => call.partNumber);
    expect(afterResume).not.toContain(1);
    expect(afterResume).not.toContain(2);
  });

  it("carries the earlier Parts' ETags into finalising", async () => {
    const { platform, phase } = gated();
    const { batch, transport } = build(platform);

    await batch.start();
    phase.open = true;
    await batch.resume();

    expect(transport.state.completes[0]!.parts).toEqual([
      { partNumber: 1, eTag: '"etag-1"' },
      { partNumber: 2, eTag: '"etag-2"' },
      { partNumber: 3, eTag: '"etag-3"' },
      { partNumber: 4, eTag: '"etag-4"' },
      { partNumber: 5, eTag: '"etag-5"' },
    ]);
  });

  it("gives the unfinished Parts a fresh Retry budget", async () => {
    const { platform, phase } = gated();
    const { batch } = build(platform);

    await batch.start();
    const exhausted = batch.getSnapshot().uploads[0]!.parts[2]!.attempts;
    expect(exhausted).toBe(2);

    phase.open = true;
    await batch.resume();

    expect(batch.getSnapshot().uploads[0]!.parts[2]!.attempts).toBe(1);
  });

  it("returns to failed and stays resumable when it fails again", async () => {
    const { platform } = gated();
    const { batch } = build(platform);

    await batch.start();
    const snapshot = await batch.resume();

    expect(snapshot.uploads[0]!.status).toBe("failed");
    expect(snapshot.uploads[0]!.resumable).toBe(true);
  });

  it("recovers an Upload whose Parts all landed but whose finalising failed", async () => {
    // Every Part is on the provider; only the last step failed. Treating this
    // as finished would strand the object unfinalised with no way back.
    let refuse = true;
    const transport = createFakeTransport({
      onComplete: () => {
        if (refuse) throw new Error("finalise unavailable");
      },
    });
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport,
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const failed = await batch.start();
    expect(failed.uploads[0]!.error?.code).toBe("TRANSPORT_COMPLETE_FAILED");
    expect(failed.uploads[0]!.resumable).toBe(true);

    refuse = false;
    const resumed = await batch.resume();

    expect(resumed.uploads[0]!.status).toBe("succeeded");
    expect(transport.state.completes).toHaveLength(2);
  });

  it("does not offer a Resume for a file that could never be planned", async () => {
    const batch = createUploader({
      files: [makeFile(0)],
      transport: createFakeTransport(),
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const snapshot = await batch.start();

    // Resuming would fail identically, so it is not offered.
    expect(snapshot.uploads[0]!.error?.code).toBe("EMPTY_FILE");
    expect(snapshot.uploads[0]!.resumable).toBe(false);
  });

  it("can be driven for one Upload or for the whole Batch", async () => {
    const platform = createFakePlatform({ script: () => ({ kind: "network" }) });
    const batch = createUploader({
      files: [makeFile(25 * KB, "a.mov"), makeFile(25 * KB, "b.mov")],
      transport: createFakeTransport(),
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      maxRetries: 0,
    });

    await batch.start();
    const targeted = await batch.resume("upload-1");
    expect(targeted.uploads[0]!.resumable).toBe(true);

    const all = await batch.resume();
    expect(all.uploads.every((upload) => upload.status === "failed")).toBe(true);
  });
});
