import { describe, expect, it, vi } from "vitest";

import { createUploader } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const base = (transport = createFakeTransport(), platform = createFakePlatform()) => ({
  transport,
  platform,
  partSize: 10 * KB,
  provider: { minPartSize: 1 },
});

describe("a misbehaving subscriber", () => {
  it("cannot take the Batch down with it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const options = base();
    const batch = createUploader({ files: [makeFile(25 * KB)], ...options });

    batch.subscribe(() => {
      throw new Error("render exploded");
    });

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("cannot stop siblings settling or the settled event firing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const options = base();
    const batch = createUploader({
      files: [makeFile(25 * KB, "a.mov"), makeFile(25 * KB, "b.mov")],
      ...options,
    });

    const settled = vi.fn();
    batch.on("uploader:settled", settled);
    batch.on("upload:succeeded", () => {
      throw new Error("handler exploded");
    });

    const snapshot = await batch.start();

    expect(snapshot.uploads.every((upload) => upload.status === "succeeded")).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("a misbehaving Transport", () => {
  it("rejects a url list longer than the Part list", async () => {
    const platform = createFakePlatform();
    const transport = createFakeTransport({ urlCount: (n) => n + 1 });
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      ...base(transport, platform),
    });

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.error?.code).toBe("URL_COUNT_MISMATCH");
    expect(platform.state.calls).toHaveLength(0);
  });

  it("reports an Opening failure as such, even when the thrown error is named UploadError", async () => {
    const transport = createFakeTransport({
      onOpen: () => {
        throw Object.assign(new Error("upstream refused"), { name: "UploadError" });
      },
    });
    const batch = createUploader({ files: [makeFile(25 * KB)], ...base(transport) });

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.error?.code).toBe("TRANSPORT_OPEN_FAILED");
  });

  it("reports a finalising failure as such", async () => {
    const transport = createFakeTransport({
      onComplete: () => {
        throw new Error("complete refused");
      },
    });
    const batch = createUploader({ files: [makeFile(25 * KB)], ...base(transport) });

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.error?.code).toBe("TRANSPORT_COMPLETE_FAILED");
  });
});

describe("a Part with no readable ETag", () => {
  it("fails at once with an error naming the CORS fix", async () => {
    const platform = createFakePlatform({
      script: ({ partNumber }) => (partNumber === 2 ? { kind: "no-etag" } : { kind: "ok" }),
    });
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      ...base(createFakeTransport(), platform),
    });

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.error?.code).toBe("MISSING_ETAG");
    expect(snapshot.uploads[0]!.error?.message).toContain("ExposeHeaders");
    // Failed at once rather than working through a ladder of attempts.
    expect(platform.state.calls.filter((call) => call.partNumber === 2)).toHaveLength(1);
  });
});

describe("Batch status across mixed outcomes", () => {
  it("does not report succeeded when a sibling failed", async () => {
    const platform = createFakePlatform({
      script: ({ uploadId }) => (uploadId === "upload-2" ? { kind: "no-etag" } : { kind: "ok" }),
    });
    const batch = createUploader({
      files: [makeFile(25 * KB, "a.mov"), makeFile(25 * KB, "b.mov")],
      ...base(createFakeTransport(), platform),
    });

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.status).toBe("succeeded");
    expect(snapshot.uploads[1]!.status).toBe("failed");
    expect(snapshot.status).toBe("failed");
  });

  it("counts Attempts per Upload, not per Part number across the Batch", async () => {
    const platform = createFakePlatform();
    const batch = createUploader({
      files: [makeFile(25 * KB, "a.mov"), makeFile(25 * KB, "b.mov")],
      ...base(createFakeTransport(), platform),
    });

    await batch.start();

    // Every send is a first Attempt: six sends, none of them a repeat.
    expect(platform.state.calls).toHaveLength(6);
    expect(platform.state.calls.every((call) => call.attempt === 1)).toBe(true);
  });
});
