import { describe, expect, it } from "vitest";

import { createUploader } from "../src/index.js";
import { flush } from "./fakes/async.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const isNonDecreasing = (values: number[]): boolean =>
  values.every((value, index) => index === 0 || value >= values[index - 1]!);

describe("progress", () => {
  it("never goes backwards when a Part is Retried after sending some bytes", async () => {
    // The fake reports the whole Part as sent before the Attempt fails, as a
    // real upload does when the response is what fails.
    const platform = createFakePlatform({
      script: ({ partNumber, attempt }) =>
        partNumber === 2 && attempt === 1 ? { kind: "status", status: 503 } : { kind: "ok" },
    });
    const batch = createUploader({
      files: [makeFile(30 * KB)],
      transport: createFakeTransport(),
      platform,
      partSize: 10 * KB,
      limits: { minPartSize: 1 },
      concurrency: 1,
    });

    const batchLoaded: number[] = [];
    const uploadLoaded: number[] = [];
    batch.subscribe((snapshot) => {
      batchLoaded.push(snapshot.progress.loaded);
      uploadLoaded.push(snapshot.uploads[0]!.progress.loaded);
    });

    const settled = await batch.start();

    expect(settled.progress.percent).toBe(100);
    expect(isNonDecreasing(batchLoaded)).toBe(true);
    expect(isNonDecreasing(uploadLoaded)).toBe(true);
  });

  it("reaches exactly the total and never exceeds it", async () => {
    const batch = createUploader({
      files: [makeFile(25 * KB), makeFile(7 * KB, "b.mov")],
      transport: createFakeTransport(),
      platform: createFakePlatform(),
      partSize: 10 * KB,
      limits: { minPartSize: 1 },
    });

    const seen: number[] = [];
    batch.subscribe((snapshot) => seen.push(snapshot.progress.loaded));
    const settled = await batch.start();

    expect(settled.progress.loaded).toBe(32 * KB);
    expect(Math.max(...seen)).toBe(32 * KB);
  });
});

describe("transfer speed and time remaining", () => {
  /** Three 10 KB Parts, one at a time, each taking one second of fake time. */
  const timed = () => {
    const platform = createFakePlatform({
      script: () => {
        platform.advance(1000);
        return { kind: "ok" };
      },
    });
    const batch = createUploader({
      files: [makeFile(30 * KB)],
      transport: createFakeTransport(),
      platform,
      partSize: 10 * KB,
      limits: { minPartSize: 1 },
      concurrency: 1,
    });
    return { platform, batch };
  };

  it("are unknown before any bytes have moved", () => {
    const { batch } = timed();
    const { progress } = batch.getSnapshot();

    expect(progress.bytesPerSecond).toBeNull();
    expect(progress.remainingMs).toBeNull();
  });

  it("are measured from bytes sent over time, for the Upload and the Batch", async () => {
    const { batch } = timed();
    const seen: { speed: number | null; remaining: number | null; loaded: number }[] = [];
    batch.subscribe((snapshot) =>
      seen.push({
        speed: snapshot.uploads[0]!.progress.bytesPerSecond,
        remaining: snapshot.progress.remainingMs,
        loaded: snapshot.progress.loaded,
      }),
    );

    await batch.start();

    // Once two Parts are in, 20 KB has moved in two seconds and 10 KB is left.
    const midway = seen.find((entry) => entry.loaded === 20 * KB && entry.speed !== null)!;
    expect(midway.speed).toBe(10 * KB);
    expect(midway.remaining).toBe(1000);
  });

  it("are cleared once the Upload is no longer moving", async () => {
    const { batch } = timed();
    const settled = await batch.start();

    expect(settled.progress.bytesPerSecond).toBeNull();
    expect(settled.uploads[0]!.progress.remainingMs).toBeNull();
  });

  it("do not count time spent paused", async () => {
    const { platform, batch } = timed();
    await batch.pause();
    platform.advance(60_000);

    const seen: (number | null)[] = [];
    batch.subscribe((snapshot) => seen.push(snapshot.uploads[0]!.progress.bytesPerSecond));
    await batch.resume();

    expect(seen.filter((speed) => speed !== null).every((speed) => speed === 10 * KB)).toBe(true);
  });

  it("stop reporting a speed for an Upload whose transfer has stalled", async () => {
    // upload-1's second Part never answers; upload-2 keeps the clock moving.
    const platform = createFakePlatform({
      script: ({ id, partNumber }) => {
        if (id === "upload-1" && partNumber === 2) return { kind: "hang" };
        platform.advance(2000);
        return { kind: "ok" };
      },
    });
    const batch = createUploader({
      files: [makeFile(20 * KB, "stalls.mov"), makeFile(40 * KB, "moves.mov")],
      transport: createFakeTransport(),
      platform,
      partSize: 10 * KB,
      limits: { minPartSize: 1 },
      concurrency: 2,
    });

    let atEnd: ReturnType<typeof batch.getSnapshot> | null = null;
    batch.on("upload:succeeded", () => {
      atEnd = batch.getSnapshot();
    });
    const run = batch.start();
    await flush(10);

    expect(atEnd!.uploads[0]!.status).toBe("uploading");
    expect(atEnd!.uploads[0]!.progress.bytesPerSecond).toBeNull();
    expect(atEnd!.progress.bytesPerSecond).toBeNull();

    await batch.cancel();
    await run;
  });
});
