import { describe, expect, it } from "vitest";

import { createBatch } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform, type Script } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const build = (script: Script, extra = {}) => {
  const platform = createFakePlatform({ script });
  const transport = createFakeTransport();
  return {
    platform,
    transport,
    batch: createBatch({
      files: [makeFile(25 * KB)],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      concurrency: 1,
      ...extra,
    }),
  };
};

describe("a Presigned URL that expired mid-upload", () => {
  it("re-Opens for fresh urls and carries on", async () => {
    const { batch, transport } = build(({ partNumber, attempt }) =>
      partNumber === 2 && attempt === 1 ? { kind: "status", status: 403 } : { kind: "ok" },
    );

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(transport.state.opens).toHaveLength(2);
    expect(transport.state.opens[1]!.resumeFrom).toEqual({
      key: "uploads/clip.mov",
      uploadId: "upload-0",
    });
  });

  it("uses the freshly minted urls for everything after", async () => {
    const { batch, platform } = build(({ partNumber, attempt }) =>
      partNumber === 1 && attempt === 1 ? { kind: "status", status: 403 } : { kind: "ok" },
    );

    await batch.start();

    const [first, ...rest] = platform.state.calls;
    expect(first!.url).toContain("open0");
    expect(rest.every((call) => call.url.includes("open1"))).toBe(true);
  });

  it("does not spend a Retry on the re-Open", async () => {
    const { batch, platform } = build(
      ({ partNumber, attempt }) =>
        partNumber === 1 && attempt === 1 ? { kind: "status", status: 403 } : { kind: "ok" },
      { maxRetries: 0 },
    );

    // With no Retries at all, the re-Open path is the only way this succeeds.
    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(platform.state.sleeps).toHaveLength(0);
  });

  it("gives up when a second 403 follows the re-Open", async () => {
    const { batch, transport } = build(() => ({ kind: "status", status: 403 }));

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.status).toBe("failed");
    // Opened once at the start, once more to recover, and no further.
    expect(transport.state.opens).toHaveLength(2);
  });

  it("treats 401 the same way", async () => {
    const { batch, transport } = build(({ partNumber, attempt }) =>
      partNumber === 1 && attempt === 1 ? { kind: "status", status: 401 } : { kind: "ok" },
    );

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(transport.state.opens).toHaveLength(2);
  });

  it("recovers from a second expiry later in a long upload", async () => {
    // Urls go stale twice. Each expiry is separated by Parts that landed, so
    // each is a genuine expiry rather than a standing authorisation failure.
    const { batch, transport } = build(({ partNumber, attempt }) =>
      (partNumber === 1 || partNumber === 3) && attempt === 1
        ? { kind: "status", status: 403 }
        : { kind: "ok" },
    );

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(transport.state.opens).toHaveLength(3);
  });

  it("still gives up when the 403s come back to back with nothing landing", async () => {
    const { batch, transport } = build(({ partNumber }) =>
      partNumber === 1 ? { kind: "status", status: 403 } : { kind: "ok" },
    );

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.status).toBe("failed");
    expect(transport.state.opens).toHaveLength(2);
  });

  it("does not re-Open for any other status", async () => {
    const { batch, transport } = build(({ attempt }) =>
      attempt === 1 ? { kind: "status", status: 500 } : { kind: "ok" },
    );

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(transport.state.opens).toHaveLength(1);
  });

  it("leaves the Upload resumable when the re-Open itself cannot save it", async () => {
    const { batch } = build(() => ({ kind: "status", status: 403 }));

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.resumable).toBe(true);
  });
});
