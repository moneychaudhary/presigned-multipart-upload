import { crc32 } from "node:zlib";

import { describe, expect, it } from "vitest";

import { createUploader, httpTransport, listResumable, resumeUploader } from "../src/index.js";
import { createMemoryStore } from "../src/advanced.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

/**
 * The reference value, from Node's own zlib rather than the library's code:
 * CRC32 of the bytes, as a big-endian 4-byte value, base64 — S3's format.
 */
const expected = async (blob: Blob): Promise<string> => {
  const value = crc32(new Uint8Array(await blob.arrayBuffer()));
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes.toString("base64");
};

const FILE_SIZE = 25 * KB;
const PART = 10 * KB;

const build = (extra: Record<string, unknown> = {}) => {
  const file = makeFile(FILE_SIZE);
  const platform = createFakePlatform();
  const transport = createFakeTransport({ signsParts: true });
  const batch = createUploader({
    files: [file],
    transport,
    platform,
    partSize: PART,
    limits: { minPartSize: 1 },
    checksum: "CRC32",
    ...extra,
  });
  return { file, platform, transport, batch };
};

const sliceOf = (file: File, partNumber: number): Blob =>
  file.slice((partNumber - 1) * PART, Math.min(partNumber * PART, file.size));

describe("checksums", () => {
  it("tells Opening which algorithm the Parts will carry", async () => {
    const { transport, batch } = build();
    await batch.start();

    expect(transport.state.opens[0]!.checksumAlgorithm).toBe("CRC32");
  });

  it("hands each Part's CRC32 to signing, so it can be signed into the url", async () => {
    const { file, transport, batch } = build();
    await batch.start();

    const signed = Object.assign({}, ...transport.state.signs.map((sign) => sign.checksumsCRC32));
    expect(signed).toEqual({
      1: await expected(sliceOf(file, 1)),
      2: await expected(sliceOf(file, 2)),
      3: await expected(sliceOf(file, 3)),
    });
  });

  it("sends the same value as the header the signature covers", async () => {
    const { file, platform, batch } = build();
    await batch.start();

    for (const call of platform.state.calls) {
      expect(call.headers["x-amz-checksum-crc32"]).toBe(
        await expected(sliceOf(file, call.partNumber)),
      );
    }
  });

  it("passes each Part's checksum to finalising", async () => {
    const { file, transport, batch } = build();
    await batch.start();

    expect(transport.state.completes[0]!.parts).toEqual([
      { partNumber: 1, eTag: '"etag-1"', checksumCRC32: await expected(sliceOf(file, 1)) },
      { partNumber: 2, eTag: '"etag-2"', checksumCRC32: await expected(sliceOf(file, 2)) },
      { partNumber: 3, eTag: '"etag-3"', checksumCRC32: await expected(sliceOf(file, 3)) },
    ]);
  });

  it("re-signs with the same checksums when urls are refreshed", async () => {
    const { transport, batch } = build({
      platform: createFakePlatform({
        script: ({ attempt }) => (attempt === 1 ? { kind: "status", status: 403 } : { kind: "ok" }),
      }),
    });
    await batch.start();

    const first = transport.state.signs[0]!.checksumsCRC32!;
    const later = transport.state.signs.slice(1).map((sign) => sign.checksumsCRC32!);
    for (const sums of later) {
      for (const [partNumber, value] of Object.entries(sums))
        expect(value).toBe(first[Number(partNumber)]);
    }
  });

  it("carries landed Parts' checksums across a reload, into finalising", async () => {
    const store = createMemoryStore();
    const file = makeFile(FILE_SIZE);
    await createUploader({
      files: [file],
      transport: createFakeTransport({ signsParts: true }),
      platform: createFakePlatform({
        script: ({ partNumber }) =>
          partNumber === 3 ? { kind: "status", status: 400 } : { kind: "ok" },
      }),
      store,
      partSize: PART,
      limits: { minPartSize: 1 },
      checksum: "CRC32",
      concurrency: 1,
    }).start();

    const [interrupted] = await listResumable({ store, platform: createFakePlatform() });
    const transport = createFakeTransport({ signsParts: true });
    const revived = await resumeUploader({
      store,
      transport,
      platform: createFakePlatform(),
      resume: [{ id: interrupted!.id, file }],
      checksum: "CRC32",
    });
    await revived.resume();

    const parts = transport.state.completes[0]!.parts;
    expect(parts.map((part) => part.checksumCRC32)).toEqual([
      await expected(sliceOf(file, 1)),
      await expected(sliceOf(file, 2)),
      await expected(sliceOf(file, 3)),
    ]);
  });

  it("covers a single PUT too, through openSingle", async () => {
    const file = makeFile(8 * KB);
    const platform = createFakePlatform();
    const transport = createFakeTransport({ signsParts: true, opensSingle: true });
    await createUploader({
      files: [file],
      transport,
      platform,
      partSize: PART,
      limits: { minPartSize: 1 },
      checksum: "CRC32",
    }).start();

    expect(transport.state.singles[0]!.checksumCRC32).toBe(await expected(file));
    expect(platform.state.calls[0]!.headers["x-amz-checksum-crc32"]).toBe(await expected(file));
  });

  it("are off unless asked for", async () => {
    const { platform, transport, batch } = build({ checksum: undefined });
    await batch.start();

    expect(transport.state.signs[0]!.checksumsCRC32).toBeUndefined();
    expect(platform.state.calls[0]!.headers["x-amz-checksum-crc32"]).toBeUndefined();
    expect(transport.state.completes[0]!.parts[0]).not.toHaveProperty("checksumCRC32");
  });

  it("are refused up front without signParts, which is the only way to sign them in time", () => {
    expect(() =>
      createUploader({
        files: [makeFile(FILE_SIZE)],
        transport: createFakeTransport(),
        checksum: "CRC32",
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_OPTIONS" }));
  });

  it("travel through the JSON Transport to your sign and complete endpoints", async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport = httpTransport({
      baseUrl: "https://app.example/api/uploads",
      paths: { sign: "/sign" },
      fetch: (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push({ path: new URL(url).pathname, ...body });
        if (url.endsWith("/sign")) {
          const numbers = body.partNumbers as number[];
          return new Response(
            JSON.stringify({
              urls: Object.fromEntries(numbers.map((n) => [n, `https://s3/${n}`])),
            }),
          );
        }
        return new Response(JSON.stringify({ key: "k", uploadId: "u" }));
      }) as never,
    });

    await createUploader({
      files: [makeFile(FILE_SIZE)],
      transport,
      platform: createFakePlatform(),
      partSize: PART,
      limits: { minPartSize: 1 },
      checksum: "CRC32",
    }).start();

    expect(bodies.find((b) => b.path === "/api/uploads")).toMatchObject({
      checksumAlgorithm: "CRC32",
    });
    expect(bodies.find((b) => b.path === "/api/uploads/sign")).toHaveProperty("checksumsCRC32");
    const complete = bodies.find((b) => b.path === "/api/uploads/complete") as {
      parts: { checksumCRC32?: string }[];
    };
    expect(complete.parts.every((part) => typeof part.checksumCRC32 === "string")).toBe(true);
  });
});
