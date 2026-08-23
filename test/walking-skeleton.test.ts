import { describe, expect, it, vi } from "vitest";

import { createUploader } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

/** Small Parts keep fixtures readable; the provider minimum is relaxed to suit. */
const harness = (overrides: Record<string, unknown> = {}) => {
  const platform = createFakePlatform();
  const transport = createFakeTransport();
  return {
    platform,
    transport,
    options: {
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      ...overrides,
    },
  };
};

describe("uploading a single file", () => {
  it("uploads every Part and reaches succeeded", async () => {
    const { platform, transport, options } = harness();
    const batch = createUploader({ files: [makeFile(25 * KB)], ...options });

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.uploads[0]!.status).toBe("succeeded");
    expect(platform.state.calls).toHaveLength(3);
    expect(transport.state.completes).toHaveLength(1);
  });

  it("asks the Transport to open once, telling it this is not a Resume", async () => {
    const { transport, options } = harness();
    const batch = createUploader({ files: [makeFile(25 * KB)], ...options });

    await batch.start();

    expect(transport.state.opens).toHaveLength(1);
    expect(transport.state.opens[0]!.resumeFrom).toBeUndefined();
    expect(transport.state.opens[0]!.partCount).toBe(3);
  });

  it("finalises with every Part and its ETag, sorted ascending", async () => {
    const { transport, options } = harness();
    const batch = createUploader({ files: [makeFile(25 * KB)], ...options });

    await batch.start();

    expect(transport.state.completes[0]!.parts).toEqual([
      { partNumber: 1, eTag: '"etag-1"' },
      { partNumber: 2, eTag: '"etag-2"' },
      { partNumber: 3, eTag: '"etag-3"' },
    ]);
  });

  it("reports progress reaching exactly the file size and never beyond", async () => {
    const { options } = harness();
    const size = 25 * KB;
    const batch = createUploader({ files: [makeFile(size)], ...options });

    const seen: number[] = [];
    batch.subscribe((s) => seen.push(s.progress.loaded));
    const snapshot = await batch.start();

    expect(snapshot.progress.loaded).toBe(size);
    expect(snapshot.progress.total).toBe(size);
    expect(snapshot.progress.percent).toBe(100);
    expect(Math.max(...seen)).toBeLessThanOrEqual(size);
  });
});

describe("planning Parts", () => {
  const partCountFor = async (size: number, partSize: number): Promise<number> => {
    const { options } = harness({ partSize });
    const batch = createUploader({ files: [makeFile(size)], ...options });
    await batch.start();
    return batch.getSnapshot().uploads[0]!.parts.length;
  };

  it("yields exactly one Part for a file smaller than the Part size", async () => {
    expect(await partCountFor(3 * KB, 10 * KB)).toBe(1);
  });

  it("yields no trailing empty Part for a file on a Part boundary", async () => {
    expect(await partCountFor(20 * KB, 10 * KB)).toBe(2);
  });

  it("yields a final short Part for a file one byte over a boundary", async () => {
    const { options } = harness({ partSize: 10 * KB });
    const batch = createUploader({ files: [makeFile(20 * KB + 1)], ...options });
    await batch.start();

    const parts = batch.getSnapshot().uploads[0]!.parts;
    expect(parts).toHaveLength(3);
    expect(parts[2]!.size).toBe(1);
  });

  it("numbers Parts from 1, contiguously", async () => {
    const { options } = harness();
    const batch = createUploader({ files: [makeFile(25 * KB)], ...options });
    await batch.start();

    expect(batch.getSnapshot().uploads[0]!.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
  });

  it("rejects a file needing more Parts than the provider allows, before any request", async () => {
    const { platform, transport, options } = harness({ partSize: 1 * KB, provider: { minPartSize: 1, maxParts: 5 } });
    const batch = createUploader({ files: [makeFile(20 * KB)], ...options });

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.status).toBe("failed");
    expect(snapshot.uploads[0]!.error?.code).toBe("PART_COUNT_EXCEEDED");
    expect(transport.state.opens).toHaveLength(0);
    expect(platform.state.calls).toHaveLength(0);
  });

  it("rejects an empty file explicitly rather than silently", async () => {
    const { transport, options } = harness();
    const batch = createUploader({ files: [makeFile(0)], ...options });

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.status).toBe("failed");
    expect(snapshot.uploads[0]!.error?.code).toBe("EMPTY_FILE");
    expect(transport.state.opens).toHaveLength(0);
  });

  it("rejects a Transport that returns fewer urls than Parts", async () => {
    const platform = createFakePlatform();
    const transport = createFakeTransport({ urlCount: (n) => n - 1 });
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.status).toBe("failed");
    expect(snapshot.uploads[0]!.error?.code).toBe("URL_COUNT_MISMATCH");
    expect(platform.state.calls).toHaveLength(0);
  });
});

describe("observing", () => {
  it("notifies subscribers on change and stops after unsubscribing", async () => {
    const { options } = harness();
    const batch = createUploader({ files: [makeFile(25 * KB)], ...options });

    const listener = vi.fn();
    const unsubscribe = batch.subscribe(listener);
    await batch.start();
    const countWhileSubscribed = listener.mock.calls.length;

    expect(countWhileSubscribed).toBeGreaterThan(0);

    unsubscribe();
    const batchTwo = createUploader({ files: [makeFile(25 * KB)], ...options });
    await batchTwo.start();

    expect(listener.mock.calls.length).toBe(countWhileSubscribed);
  });

  it("gives a late subscriber the current state immediately", async () => {
    const { options } = harness();
    const batch = createUploader({ files: [makeFile(25 * KB)], ...options });
    await batch.start();

    const listener = vi.fn();
    batch.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0].status).toBe("succeeded");
  });

  it("hands out snapshots that cannot be mutated", async () => {
    const { options } = harness();
    const batch = createUploader({ files: [makeFile(25 * KB)], ...options });
    await batch.start();

    const snapshot = batch.getSnapshot();
    expect(() => {
      (snapshot as { status: string }).status = "tampered";
    }).toThrow();
    expect(batch.getSnapshot().status).toBe("succeeded");
  });

  it("keeps snapshot identity stable when nothing has changed", async () => {
    const { options } = harness();
    const batch = createUploader({ files: [makeFile(25 * KB)], ...options });
    await batch.start();

    expect(batch.getSnapshot()).toBe(batch.getSnapshot());
  });

  it("emits each lifecycle event once", async () => {
    const { options } = harness();
    const batch = createUploader({ files: [makeFile(25 * KB)], ...options });

    const landed = vi.fn();
    const succeeded = vi.fn();
    const settled = vi.fn();
    batch.on("part:landed", landed);
    batch.on("upload:succeeded", succeeded);
    batch.on("uploader:settled", settled);

    await batch.start();

    expect(landed).toHaveBeenCalledTimes(3);
    expect(succeeded).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("stops delivering events after the handler is removed", async () => {
    const { options } = harness();
    const batch = createUploader({ files: [makeFile(25 * KB)], ...options });

    const landed = vi.fn();
    const off = batch.on("part:landed", landed);
    off();

    await batch.start();

    expect(landed).not.toHaveBeenCalled();
  });
});
