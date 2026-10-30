import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { createUploader, httpTransport } from "../src/index.js";
import { createUploadHandler, type UploadHandlerOptions } from "../src/server.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";

/** A real client, so presigning is real signing; only its network calls are stubbed. */
const client = (
  requestChecksumCalculation: "WHEN_REQUIRED" | "WHEN_SUPPORTED" = "WHEN_REQUIRED",
) => {
  const s3 = new S3Client({
    region: "us-east-1",
    endpoint: "https://s3.example",
    forcePathStyle: true,
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    requestChecksumCalculation,
  });
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  vi.spyOn(s3, "send").mockImplementation(
    async (command: { constructor: { name: string }; input: object }) => {
      sent.push({
        name: command.constructor.name,
        input: command.input as Record<string, unknown>,
      });
      return { UploadId: "mpu-1" } as never;
    },
  );
  return { s3, sent };
};

const setup = (extra: Partial<UploadHandlerOptions> = {}, checksumSetting?: "WHEN_SUPPORTED") => {
  const { s3, sent } = client(checksumSetting);
  const handler = createUploadHandler({
    s3,
    bucket: "uploads",
    key: (file) => `u/${file.name}`,
    ...extra,
  });
  const post = async (path: string, body: unknown) => {
    const response = await handler(
      new Request(`https://app.example/api/uploads${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { handler, post, sent };
};

const file = { name: "clip.mov", size: 30 * 1024 * 1024, type: "video/quicktime", lastModified: 1 };

describe("the server handler", () => {
  it("opens a multipart upload at the key you choose, expecting checksums when asked", async () => {
    const { post, sent } = setup();
    const opened = await post("", { ...file, checksumAlgorithm: "CRC32" });

    expect(opened).toEqual({ status: 200, body: { key: "u/clip.mov", uploadId: "mpu-1" } });
    expect(sent[0]).toMatchObject({
      name: "CreateMultipartUploadCommand",
      input: {
        Bucket: "uploads",
        Key: "u/clip.mov",
        ChecksumAlgorithm: "CRC32",
        ContentType: "video/quicktime",
      },
    });
  });

  it("takes up an existing upload on resume instead of opening a second", async () => {
    const { post, sent } = setup();
    const resumed = await post("", {
      ...file,
      resumeFrom: { key: "u/clip.mov", uploadId: "mpu-9" },
    });

    expect(resumed.body).toEqual({ key: "u/clip.mov", uploadId: "mpu-9" });
    expect(sent).toHaveLength(0);
  });

  it("signs each named part, with its checksum as a signed header", async () => {
    const { post } = setup();
    const signed = await post("/sign", {
      key: "u/clip.mov",
      uploadId: "mpu-1",
      partNumbers: [1, 2],
      checksumsCRC32: { 1: "AAAAAA==", 2: "BBBBBB==" },
    });

    const urls = signed.body.urls as Record<string, string>;
    expect(Object.keys(urls)).toEqual(["1", "2"]);
    const first = new URL(urls["1"]!);
    expect(first.searchParams.get("partNumber")).toBe("1");
    expect(first.searchParams.get("uploadId")).toBe("mpu-1");
    expect(first.searchParams.get("X-Amz-SignedHeaders")).toContain("x-amz-checksum-crc32");
  });

  it("signs a single PUT that stores the file's content type", async () => {
    const { post } = setup();
    const single = await post("/single", { name: "photo.jpg", size: 1000, type: "image/jpeg" });

    expect(single.body.key).toBe("u/photo.jpg");
    expect(new URL(single.body.url as string).searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-type",
    );
  });

  it("finalises with every part's ETag and checksum, and aborts", async () => {
    const { post, sent } = setup();
    await post("/complete", {
      key: "u/clip.mov",
      uploadId: "mpu-1",
      parts: [{ partNumber: 1, eTag: '"a"', checksumCRC32: "AAAAAA==" }],
    });
    await post("/abort", { key: "u/clip.mov", uploadId: "mpu-1" });

    expect(sent.map((s) => s.name)).toEqual([
      "CompleteMultipartUploadCommand",
      "AbortMultipartUploadCommand",
    ]);
    expect(sent[0]!.input.MultipartUpload).toEqual({
      Parts: [{ PartNumber: 1, ETag: '"a"', ChecksumCRC32: "AAAAAA==" }],
    });
  });

  it("names its default keys unguessably, and strips directories from file names", async () => {
    const { s3 } = client();
    vi.spyOn(s3, "send").mockResolvedValue({ UploadId: "x" } as never);
    const handler = createUploadHandler({ s3, bucket: "uploads" });
    const response = await handler(
      new Request("https://app.example/api/uploads", {
        method: "POST",
        body: JSON.stringify({ ...file, name: "../../etc/passwd" }),
      }),
    );
    const { key } = (await response.json()) as { key: string };

    // "../../etc/passwd": no slashes survive, and a leading run of dots is replaced.
    expect(key).toMatch(/^uploads\/[0-9a-f-]{36}\/__\.\._etc_passwd$/);
    expect(key.split("/")).toHaveLength(3);
  });
});

describe("the server handler's refusals", () => {
  it("refuses a request authorize rejects, for every endpoint that names an upload", async () => {
    const { post, sent } = setup({ authorize: (_req, key) => key.startsWith("mine/") });
    const someoneElse = { key: "theirs/x", uploadId: "mpu-1" };

    expect((await post("/sign", { ...someoneElse, partNumbers: [1] })).status).toBe(403);
    expect(
      (await post("/complete", { ...someoneElse, parts: [{ partNumber: 1, eTag: "e" }] })).status,
    ).toBe(403);
    expect((await post("/abort", someoneElse)).status).toBe(403);
    expect((await post("", { ...file, resumeFrom: someoneElse })).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("refuses files over the size limit and types not allowed", async () => {
    const { post } = setup({ maxSize: 1024, allowedTypes: ["image/*"] });

    expect((await post("", file)).status).toBe(413);
    expect((await post("/single", { name: "a.txt", size: 10, type: "text/plain" })).status).toBe(
      415,
    );
    expect((await post("/single", { name: "a.png", size: 10, type: "image/png" })).status).toBe(
      200,
    );
  });

  it("refuses to sign more parts in one request than it should", async () => {
    const { post } = setup();
    const many = Array.from({ length: 1001 }, (_, i) => i + 1);

    expect((await post("/sign", { key: "k", uploadId: "u", partNumbers: many })).status).toBe(400);
    expect((await post("/sign", { key: "k", uploadId: "u", partNumbers: [0] })).status).toBe(400);
  });

  it("refuses malformed requests rather than passing them to S3", async () => {
    const { handler, post } = setup();
    const notJson = await handler(
      new Request("https://app.example/api/uploads", { method: "POST", body: "{" }),
    );

    expect(notJson.status).toBe(400);
    expect((await post("", { name: "x" })).status).toBe(400);
    expect((await post("/complete", { key: "k", uploadId: "u", parts: [] })).status).toBe(400);
  });

  it("names the SDK setting that would otherwise break every presigned upload", async () => {
    const { post } = setup({}, "WHEN_SUPPORTED");
    const response = await post("", file);

    expect(response.status).toBe(500);
    expect(response.body.error).toContain("WHEN_REQUIRED");
  });

  it("hides S3's own error from the browser", async () => {
    const { s3 } = client();
    vi.spyOn(s3, "send").mockRejectedValue(new Error("NoSuchBucket: secret-bucket-name"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = createUploadHandler({ s3, bucket: "secret-bucket-name" });
    const response = await handler(
      new Request("https://app.example/api/uploads", {
        method: "POST",
        body: JSON.stringify(file),
      }),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret-bucket-name");
  });
});

describe("the server handler behind httpTransport", () => {
  it("carries a whole checksummed upload, open to complete", async () => {
    const { handler, sent } = setup();
    const transport = httpTransport({
      baseUrl: "https://app.example/api/uploads",
      fetch: ((url: string, init: RequestInit) => handler(new Request(url, init))) as typeof fetch,
    });

    const settled = await createUploader({
      files: [makeFile(25 * KB)],
      transport,
      platform: createFakePlatform(),
      partSize: 10 * KB,
      limits: { minPartSize: 1 },
      checksum: "CRC32",
    }).start();

    expect(settled.status).toBe("succeeded");
    const done = sent.find((s) => s.name === "CompleteMultipartUploadCommand")!;
    const parts = (done.input.MultipartUpload as { Parts: { ChecksumCRC32?: string }[] }).Parts;
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => typeof p.ChecksumCRC32 === "string")).toBe(true);
  });
});
