import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { beforeAll, describe, expect, it } from "vitest";

import { createUploader, httpTransport, type Transport } from "../../src/index.js";
import { createUploadHandler } from "../../src/server.js";
import { nodePlatform } from "./node-platform.js";

const ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://127.0.0.1:9000";
const ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "minioadmin";
const SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "minioadmin";
const BUCKET = process.env.MINIO_BUCKET ?? "presigned-multipart-upload-test";
const MIB = 1024 * 1024;

const reachable = async (): Promise<boolean> => {
  try {
    // MinIO answers its health endpoint without credentials.
    const response = await fetch(`${ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const available = await reachable();

if (!available) {
  describe.skip(`MinIO smoke test (no server at ${ENDPOINT})`, () => {
    it("is skipped", () => {
      expect(true).toBe(true);
    });
  });
  console.info(
    `\nSkipping the MinIO smoke test: nothing answering at ${ENDPOINT}.\n` +
      `Start one with:\n` +
      `  npm run minio:up\n`,
  );
}

describe.skipIf(!available)("uploading to a real S3-compatible server", () => {
  const client = new S3Client({
    endpoint: ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    // Without these, recent SDKs sign an empty body's CRC32 into every
    // presigned upload url, and a server that checks it refuses every Part.
    // The README tells adopters the same.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  beforeAll(async () => {
    try {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch {
      // Already there, which is fine.
    }
  });

  /**
   * A Transport standing in for the application's own API. In a real app these
   * three calls live on the server, which is the whole point of the design —
   * the browser never holds credentials.
   */
  const transportFor = (key: string): Transport => ({
    open: async (_file, ctx) => {
      const uploadId =
        ctx.resumeFrom?.uploadId ??
        (await client.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key })))
          .UploadId!;

      const urls = await Promise.all(
        Array.from({ length: ctx.partCount }, (_, index) =>
          getSignedUrl(
            client,
            new UploadPartCommand({
              Bucket: BUCKET,
              Key: key,
              UploadId: uploadId,
              PartNumber: index + 1,
            }),
            { expiresIn: 900 },
          ),
        ),
      );

      return { key, uploadId, urls };
    },

    complete: async ({ key: objectKey, uploadId, parts }) =>
      client.send(
        new CompleteMultipartUploadCommand({
          Bucket: BUCKET,
          Key: objectKey,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.eTag })),
          },
        }),
      ),

    abort: async ({ key: objectKey, uploadId }) =>
      client.send(
        new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: objectKey, UploadId: uploadId }),
      ),
  });

  /**
   * The shipped backend, `presigned-multipart-upload/server`, behind the JSON
   * Transport: signing on demand, single PUTs and checksums, against a server
   * that enforces what it signs.
   */
  const signingTransportFor = (key: string): Transport => {
    const handler = createUploadHandler({ s3: client, bucket: BUCKET, key: () => key });
    return httpTransport({
      baseUrl: "http://app.test/api/uploads",
      fetch: ((url: string, init: RequestInit) => handler(new Request(url, init))) as typeof fetch,
    });
  };

  const fileOf = (size: number, name: string, seed = 1): { file: File; bytes: Uint8Array } => {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = (i * seed) % 251;
    return { file: new File([bytes], name, { type: "application/octet-stream" }), bytes };
  };

  const stored = async (key: string): Promise<Uint8Array> => {
    const object = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return new Uint8Array(await object.Body!.transformToByteArray());
  };

  it("completes a checksummed multipart upload signed on demand", async () => {
    const key = `smoke/${Date.now()}-checksummed.bin`;
    const { file, bytes } = fileOf(12 * MIB, "checksummed.bin", 3);

    const snapshot = await createUploader({
      files: [file],
      transport: signingTransportFor(key),
      platform: nodePlatform(),
      partSize: 5 * MIB,
      checksum: "CRC32",
    }).start();

    expect(snapshot.upload?.error).toBeNull();
    expect(snapshot.status).toBe("succeeded");
    expect(Buffer.from(await stored(key)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("is refused by the server when a Part's bytes do not match its signed checksum", async () => {
    const key = `smoke/${Date.now()}-corrupt.bin`;
    const { file } = fileOf(12 * MIB, "corrupt.bin", 5);
    const platform = nodePlatform();
    // Flip one byte of Part 2 in transit, keeping the checksum header as signed.
    const corrupting = {
      ...platform,
      sendPart: async (args: Parameters<typeof platform.sendPart>[0]) => {
        if (args.partNumber !== 2) return platform.sendPart(args);
        const bytes = new Uint8Array(await args.body.arrayBuffer());
        bytes[0] = (bytes[0]! + 1) % 256;
        return platform.sendPart({ ...args, body: new Blob([bytes]) });
      },
    };

    const snapshot = await createUploader({
      files: [file],
      transport: signingTransportFor(key),
      platform: corrupting,
      partSize: 5 * MIB,
      checksum: "CRC32",
      retry: { max: 0 },
    }).start();

    expect(snapshot.status).toBe("failed");
    expect(snapshot.upload?.error?.code).toBe("SEND_FAILED");
  });

  it("sends a small file as one PUT, with and without a checksum", async () => {
    for (const checksum of [undefined, "CRC32"] as const) {
      const key = `smoke/${Date.now()}-single-${checksum ?? "plain"}.bin`;
      const { file, bytes } = fileOf(3 * MIB, "single.bin", 7);

      const snapshot = await createUploader({
        files: [file],
        transport: signingTransportFor(key),
        platform: nodePlatform(),
        ...(checksum ? { checksum } : {}),
      }).start();

      expect(snapshot.upload?.error).toBeNull();
      expect(snapshot.upload?.uploadId).toBeNull();
      expect(Buffer.from(await stored(key)).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it("completes a genuine multipart upload with bytes intact", async () => {
    // Above the 5 MiB floor so this is a real multipart upload, not one Part.
    const size = 12 * MIB;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = i % 251;

    const key = `smoke/${Date.now()}-clip.bin`;
    const file = new File([bytes], "clip.bin", { type: "application/octet-stream" });

    const batch = createUploader({
      files: [file],
      transport: transportFor(key),
      platform: nodePlatform(),
      partSize: 5 * MIB,
      concurrency: 3,
    });

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.uploads[0]!.parts).toHaveLength(3);

    const stored = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const roundTripped = new Uint8Array(await stored.Body!.transformToByteArray());

    expect(roundTripped.length).toBe(size);
    expect(roundTripped[0]).toBe(bytes[0]);
    expect(roundTripped[size - 1]).toBe(bytes[size - 1]);
    expect(roundTripped[6 * MIB]).toBe(bytes[6 * MIB]);
  });

  it("resumes a failed upload against the real server", async () => {
    const size = 12 * MIB;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) bytes[i] = (i * 7) % 251;

    const key = `smoke/${Date.now()}-resume.bin`;
    const file = new File([bytes], "resume.bin", { type: "application/octet-stream" });

    // The third Part refuses to send until the gate opens, so the first run
    // genuinely fails partway and leaves the upload open on the server.
    const gate = { open: false };
    const platform = nodePlatform();
    const guarded = {
      ...platform,
      sendPart: async (args: Parameters<typeof platform.sendPart>[0]) => {
        if (args.partNumber === 3 && !gate.open) {
          throw Object.assign(new Error("held"), { name: "NetworkError" });
        }
        return platform.sendPart(args);
      },
    };

    const batch = createUploader({
      files: [file],
      transport: transportFor(key),
      platform: guarded,
      partSize: 5 * MIB,
      concurrency: 1,
      retry: { max: 0 },
    });

    const failed = await batch.start();
    expect(failed.uploads[0]!.status).toBe("failed");

    gate.open = true;
    const resumed = await batch.resume();
    expect(resumed.uploads[0]!.status).toBe("succeeded");

    const stored = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const roundTripped = new Uint8Array(await stored.Body!.transformToByteArray());
    expect(roundTripped.length).toBe(size);
    expect(roundTripped[11 * MIB]).toBe(bytes[11 * MIB]);
  });
});
