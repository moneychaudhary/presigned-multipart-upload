import { describe, expect, it } from "vitest";
import { autoPartSize, planParts } from "../src/plan.js";
import { createUploader, createMemoryStore, PROVIDERS, type UploadError } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform, fakeHandle } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const TIB = 1024 * GIB;

const s3 = PROVIDERS.s3;

const plan = (size: number, partSize: number | "auto" = "auto") =>
  planParts({ size, partSize, ...s3 });

describe("choosing a Part size", () => {
  it("uses the preferred 10 MiB when the file does not force larger", () => {
    expect(autoPartSize({ size: 100 * MIB, ...s3 })).toBe(10 * MIB);
  });

  it("never goes below the provider minimum", () => {
    expect(autoPartSize({ size: 1, ...s3 })).toBeGreaterThanOrEqual(s3.minPartSize);
  });

  it("grows the Part so a 300 GB file fits inside the Part limit", () => {
    const size = 300 * GIB;
    const partSize = autoPartSize({ size, ...s3 });

    // 300 GiB over 10,000 Parts forces ~30.7 MiB, rounded up to whole MiB.
    expect(partSize).toBe(31 * MIB);
    expect(Math.ceil(size / partSize)).toBeLessThanOrEqual(s3.maxParts);
  });

  it("plans a 300 GB file rather than refusing it", () => {
    const { partSize, parts } = plan(300 * GIB);

    expect(parts.length).toBeLessThanOrEqual(s3.maxParts);
    expect(parts.at(-1)?.end).toBe(300 * GIB);
    expect(parts[0]!.size).toBe(partSize);
  });

  it("leaves no gap or overlap between Parts of a huge file", () => {
    const { parts } = plan(300 * GIB);

    for (let index = 1; index < parts.length; index += 1) {
      expect(parts[index]!.start).toBe(parts[index - 1]!.end);
    }
  });

  it("still refuses a fixed Part size that cannot cover the file", () => {
    expect(() => plan(300 * GIB, 10 * MIB)).toThrowError(/PART_COUNT_EXCEEDED|above the provider limit/);
  });

  it("refuses a Part above the provider maximum", () => {
    const error = (() => {
      try {
        plan(100 * GIB, 6 * GIB);
      } catch (thrown) {
        return thrown as UploadError;
      }
    })();

    expect(error?.code).toBe("INVALID_PART_SIZE");
  });

  it("refuses an object above the provider maximum before Opening anything", () => {
    const error = (() => {
      try {
        plan(6 * TIB);
      } catch (thrown) {
        return thrown as UploadError;
      }
    })();

    expect(error?.code).toBe("FILE_TOO_LARGE");
  });
});

describe("an Upload of a size no fixed Part could serve", () => {
  /** A file that reports a huge size without allocating one. */
  const pretendSize = (file: File, size: number): File => {
    Object.defineProperty(file, "size", { value: size });
    return file;
  };

  const attempt = async (file: File, partSize?: number) => {
    const transport = createFakeTransport();
    const batch = createUploader({
      files: [file],
      transport,
      platform: createFakePlatform(),
      partSize,
    });

    const snapshot = await batch.start();
    return { snapshot, transport };
  };

  it("fails before Opening anything when a fixed Part size cannot cover it", async () => {
    const { snapshot, transport } = await attempt(
      pretendSize(makeFile(KB, "huge.bin"), 300 * GIB),
      10 * MIB,
    );

    expect(snapshot.uploads[0]!.error?.code).toBe("PART_COUNT_EXCEEDED");
    // Nothing was Opened, so no multipart upload is left dangling at the provider.
    expect(transport.state.opens).toHaveLength(0);
  });

  it("fails before Opening anything when it is above the object limit", async () => {
    const { snapshot, transport } = await attempt(pretendSize(makeFile(KB, "vast.bin"), 6 * TIB));

    expect(snapshot.uploads[0]!.error?.code).toBe("FILE_TOO_LARGE");
    expect(transport.state.opens).toHaveLength(0);
  });
});

describe("what the Transport is told", () => {
  const openedWith = async (partSize?: number) => {
    const transport = createFakeTransport();
    const batch = createUploader({
      files: [makeFile(50 * KB)],
      transport,
      platform: createFakePlatform(),
      partSize,
      provider: { minPartSize: 1 },
    });

    await batch.start();
    return transport.state.opens[0]!;
  };

  it("passes the resolved Part size, never the word auto", async () => {
    const open = await openedWith();

    expect(open.partSize).toBe(10 * MIB);
    expect(open.partCount).toBe(1);
  });

  it("passes an explicit Part size through unchanged", async () => {
    const open = await openedWith(10 * KB);

    expect(open.partSize).toBe(10 * KB);
    expect(open.partCount).toBe(5);
  });
});

describe("the Upload Record", () => {
  it("carries the Part size that was used, so a Resume slices identically", async () => {
    const store = createMemoryStore();
    const file = makeFile(50 * KB);

    const batch = createUploader({
      files: [{ file, handle: fakeHandle(file) }],
      transport: createFakeTransport(),
      // Every Part from 3 on fails, leaving a Record behind.
      platform: createFakePlatform({
        script: ({ partNumber }) => (partNumber >= 3 ? { kind: "network" } : { kind: "ok" }),
      }),
      store,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      maxRetries: 0,
      concurrency: 1,
    });

    await batch.start();

    const record = await store.get("upload-1");
    expect(record?.partSize).toBe(10 * KB);
    expect(record?.partCount).toBe(5);
  });
});
