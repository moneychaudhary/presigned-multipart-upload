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

import { createUploader, type Transport } from "../../src/index.js";
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
  // eslint-disable-next-line no-console
  console.info(
    `\nSkipping the MinIO smoke test: nothing answering at ${ENDPOINT}.\n` +
      `Start one with:\n` +
      `  docker run -d -p 9000:9000 --name minio-test minio/minio server /data\n`,
  );
}

describe.skipIf(!available)("uploading to a real S3-compatible server", () => {
  const client = new S3Client({
    endpoint: ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
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
        (
          await client.send(
            new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key }),
          )
        ).UploadId!;

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
      maxRetries: 0,
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
