import { describe, expect, it, vi } from "vitest";

import { createUploader } from "../src/index.js";
import { deferred, flush } from "./fakes/async.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

describe("cancelling", () => {
  it("stops in-flight Attempts rather than waiting for the current Part", async () => {
    const platform = createFakePlatform({ script: () => ({ kind: "hang" }) });
    const transport = createFakeTransport();
    const batch = createUploader({
      files: [makeFile(50 * KB)],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const run = batch.start();
    await flush();
    expect(platform.state.calls.length).toBeGreaterThan(0);

    const snapshot = await batch.cancel();
    await run;

    expect(snapshot.uploads[0]!.status).toBe("cancelled");
  });

  it("tears the Upload down at the provider exactly once", async () => {
    const platform = createFakePlatform({ script: () => ({ kind: "hang" }) });
    const transport = createFakeTransport();
    const batch = createUploader({
      files: [makeFile(50 * KB)],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const run = batch.start();
    await flush();
    await batch.cancel();
    await batch.cancel();
    await run;

    expect(transport.state.aborts).toHaveLength(1);
  });

  it("does not tear down an Upload that already succeeded", async () => {
    const transport = createFakeTransport();
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport,
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    await batch.start();
    const snapshot = await batch.cancel();

    expect(snapshot.uploads[0]!.status).toBe("succeeded");
    expect(transport.state.aborts).toHaveLength(0);
  });

  it("tears down an Upload that finished Opening after the Cancel landed", async () => {
    // Cancelling mid-Open cannot un-create what the provider already made, so
    // once Opening resolves there is a real multipart upload to tear down.
    const gate = deferred();
    const transport = createFakeTransport({ onOpen: () => gate.promise });
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport,
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const run = batch.start();
    await flush();
    const cancelling = batch.cancel();
    gate.resolve();
    const snapshot = await cancelling;
    await run;

    expect(snapshot.uploads[0]!.status).toBe("cancelled");
    expect(transport.state.aborts).toHaveLength(1);
  });

  it("has nothing to tear down when Opening never succeeded", async () => {
    const transport = createFakeTransport({
      onOpen: () => {
        throw new Error("open refused");
      },
    });
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport,
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    await batch.start();
    await batch.cancel();

    expect(transport.state.aborts).toHaveLength(0);
  });

  it("cancels an Upload that never started", async () => {
    const transport = createFakeTransport();
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport,
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const snapshot = await batch.cancel();

    expect(snapshot.uploads[0]!.status).toBe("cancelled");
    expect(transport.state.aborts).toHaveLength(0);
  });

  it("leaves siblings running when one Upload is cancelled", async () => {
    const platform = createFakePlatform({
      script: ({ uploadId }) => (uploadId === "upload-1" ? { kind: "hang" } : { kind: "ok" }),
    });
    const batch = createUploader({
      files: [makeFile(50 * KB, "a.mov"), makeFile(25 * KB, "b.mov")],
      transport: createFakeTransport(),
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      concurrency: 8,
    });

    const run = batch.start();
    await flush();
    await batch.cancel("upload-1");
    const snapshot = await run;

    expect(snapshot.uploads[0]!.status).toBe("cancelled");
    expect(snapshot.uploads[1]!.status).toBe("succeeded");
  });

  it("tears down every non-terminal Upload once when the Batch is cancelled", async () => {
    const platform = createFakePlatform({ script: () => ({ kind: "hang" }) });
    const transport = createFakeTransport();
    const batch = createUploader({
      files: [makeFile(25 * KB, "a.mov"), makeFile(25 * KB, "b.mov")],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      concurrency: 8,
    });

    const run = batch.start();
    await flush();
    await batch.cancel();
    await run;

    expect(transport.state.aborts).toHaveLength(2);
  });

  it("reports the Batch as cancelled and announces each Upload", async () => {
    const platform = createFakePlatform({ script: () => ({ kind: "hang" }) });
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport: createFakeTransport(),
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const cancelled = vi.fn();
    batch.on("upload:cancelled", cancelled);

    const run = batch.start();
    await flush();
    const snapshot = await batch.cancel();
    await run;

    expect(snapshot.status).toBe("cancelled");
    expect(cancelled).toHaveBeenCalledWith({ id: "upload-1" });
  });

  it("survives a Transport whose teardown itself fails", async () => {
    const platform = createFakePlatform({ script: () => ({ kind: "hang" }) });
    const transport = createFakeTransport({
      onAbort: () => {
        throw new Error("abort refused");
      },
    });
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const run = batch.start();
    await flush();
    const snapshot = await batch.cancel();
    await run;

    expect(snapshot.uploads[0]!.status).toBe("cancelled");
  });
});

describe("resuming a cancelled Upload", () => {
  it("is refused, because Cancel discards the work", async () => {
    const platform = createFakePlatform({ script: () => ({ kind: "hang" }) });
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport: createFakeTransport(),
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const run = batch.start();
    await flush();
    await batch.cancel();
    await run;

    await expect(batch.resume("upload-1")).rejects.toMatchObject({ code: "NOT_RESUMABLE" });
  });
});
