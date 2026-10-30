/**
 * Your backend, done: every endpoint httpTransport calls, on S3.
 *
 * One handler on the web-standard Request → Response, so it mounts as-is in
 * Next.js route handlers, Remix, Hono, Bun and Deno; `toNodeHandler` adapts it
 * for Node's http server and Express. The browser never holds a credential —
 * it receives presigned URLs minted here, and nothing else.
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { IncomingMessage, ServerResponse } from "node:http";

import { S3_LIMITS, type FileDescriptor } from "./types.js";

export interface UploadHandlerOptions {
  s3: S3Client;
  bucket: string;
  /**
   * The object key for a new upload. Default `uploads/<random uuid>/<file name>`,
   * which no one can guess. Put the signed-in user in it to scope uploads.
   */
  key?: (file: FileDescriptor, request: Request) => string | Promise<string>;
  /**
   * Whether this request may touch the upload at `key`. Asked before resuming,
   * signing, finalising or aborting an upload that already exists — those
   * requests name their key and upload id, and both arrive from the browser.
   * Default: allow. Set it whenever keys are not unguessable per user.
   */
  authorize?: (request: Request, key: string) => boolean | Promise<boolean>;
  /** Largest file accepted, in bytes. Default 5 TiB, S3's own limit. */
  maxSize?: number;
  /** Content types accepted, exactly or as "image/*". Default: any. */
  allowedTypes?: string[];
  /** How long each presigned URL lasts, in seconds. Default 3600. */
  expiresIn?: number;
}

/** Most parts one sign request may ask for, so a request cannot make the server sign 10,000 urls. */
const MAX_SIGN_BATCH = 1_000;
const CHECKSUM_HEADER = "x-amz-checksum-crc32";

type Body = Record<string, unknown>;

/** A refusal with a status and a message the browser can show. */
const refuse = (status: number, error: string): Response => Response.json({ error }, { status });

const isRecord = (value: unknown): value is Body =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (body: Body, field: string): string | null =>
  typeof body[field] === "string" && (body[field] as string).length > 0
    ? (body[field] as string)
    : null;

/** A file name made safe to put in a key: no directories, no control characters. */
const safeName = (name: string): string =>
  [...name]
    .map((c) => (c.charCodeAt(0) < 32 || c === "/" || c === "\\" ? "_" : c))
    .join("")
    .replace(/^\.+/, "_")
    .slice(0, 200) || "file";

const typeAllowed = (type: string, allowed: string[] | undefined): boolean =>
  allowed === undefined ||
  allowed.some((pattern) =>
    pattern.endsWith("/*") ? type.startsWith(pattern.slice(0, -1)) : type === pattern,
  );

export const createUploadHandler = (options: UploadHandlerOptions) => {
  const { s3, bucket } = options;
  const maxSize = options.maxSize ?? S3_LIMITS.maxObjectSize;
  const expiresIn = options.expiresIn ?? 3600;
  const authorize = options.authorize ?? (() => true);
  const keyFor =
    options.key ??
    ((file: FileDescriptor) => `uploads/${globalThis.crypto.randomUUID()}/${safeName(file.name)}`);

  /**
   * Recent AWS SDKs sign the CRC32 of an empty body into every presigned
   * upload url unless told not to, and a store that checks it refuses every
   * part. Caught once, here, with the fix in the message.
   */
  let clientChecked: Promise<string | null> | null = null;
  const clientProblem = (): Promise<string | null> => {
    clientChecked ??= (async () => {
      const setting = s3.config.requestChecksumCalculation;
      const value = typeof setting === "function" ? await setting() : setting;
      return value === "WHEN_SUPPORTED"
        ? 'Create the S3Client with requestChecksumCalculation: "WHEN_REQUIRED"; otherwise presigned uploads carry an empty-body checksum and are refused.'
        : null;
    })();
    return clientChecked;
  };

  // The checksum stays a signed header, because the library sends it as one;
  // a single PUT also signs its Content-Type, so allowedTypes cannot be dodged
  // by sending a different type than the one asked about.
  const presign = (command: UploadPartCommand | PutObjectCommand): Promise<string> =>
    getSignedUrl(s3, command as UploadPartCommand, {
      expiresIn,
      unhoistableHeaders: new Set([CHECKSUM_HEADER]),
      ...(command instanceof PutObjectCommand
        ? { signableHeaders: new Set(["content-type"]) }
        : {}),
    });

  /** The file the browser describes, checked against the limits. */
  const describe = (body: Body): FileDescriptor | Response => {
    const name = text(body, "name");
    const size = body.size;
    const type = typeof body.type === "string" ? body.type : "";
    if (name === null || typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
      return refuse(400, "Expected { name, size, type } describing a non-empty file.");
    }
    if (size > maxSize) return refuse(413, `Files are limited to ${maxSize} bytes.`);
    if (!typeAllowed(type, options.allowedTypes))
      return refuse(415, `${type || "This type"} is not accepted.`);
    return { name, size, type, lastModified: Number(body.lastModified) || 0 };
  };

  /** The upload an existing-upload request names, if this request may touch it. */
  const target = async (
    request: Request,
    body: Body,
  ): Promise<{ key: string; uploadId: string } | Response> => {
    const key = text(body, "key");
    const uploadId = text(body, "uploadId");
    if (key === null || uploadId === null) return refuse(400, "Expected { key, uploadId }.");
    if (!(await authorize(request, key))) return refuse(403, "Not allowed to touch this upload.");
    return { key, uploadId };
  };

  const open = async (request: Request, body: Body): Promise<Response> => {
    const file = describe(body);
    if (file instanceof Response) return file;
    if (isRecord(body.resumeFrom)) {
      const existing = await target(request, body.resumeFrom);
      // Taking up the same upload is the whole point of a Resume: never open a second.
      return existing instanceof Response ? existing : Response.json(existing);
    }
    const key = await keyFor(file, request);
    const algorithm = body.checksumAlgorithm === "CRC32" ? "CRC32" : undefined;
    const created = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: file.type || undefined,
        ...(algorithm ? { ChecksumAlgorithm: algorithm } : {}),
      }),
    );
    return Response.json({ key, uploadId: created.UploadId });
  };

  const sign = async (request: Request, body: Body): Promise<Response> => {
    const upload = await target(request, body);
    if (upload instanceof Response) return upload;
    const partNumbers = body.partNumbers;
    const valid =
      Array.isArray(partNumbers) &&
      partNumbers.length > 0 &&
      partNumbers.length <= MAX_SIGN_BATCH &&
      partNumbers.every((n) => Number.isInteger(n) && n >= 1 && n <= S3_LIMITS.maxParts);
    if (!valid) return refuse(400, `Expected partNumbers: 1 to ${MAX_SIGN_BATCH} part numbers.`);
    const checksums = isRecord(body.checksumsCRC32) ? body.checksumsCRC32 : {};
    const entries = await Promise.all(
      (partNumbers as number[]).map(async (partNumber) => {
        const checksum = checksums[partNumber];
        const url = await presign(
          new UploadPartCommand({
            Bucket: bucket,
            Key: upload.key,
            UploadId: upload.uploadId,
            PartNumber: partNumber,
            ChecksumCRC32: typeof checksum === "string" ? checksum : undefined,
          }),
        );
        return [partNumber, url] as const;
      }),
    );
    return Response.json({ urls: Object.fromEntries(entries) });
  };

  const single = async (request: Request, body: Body): Promise<Response> => {
    const file = describe(body);
    if (file instanceof Response) return file;
    const key = await keyFor(file, request);
    const url = await presign(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: file.type || undefined,
        ChecksumCRC32: text(body, "checksumCRC32") ?? undefined,
      }),
    );
    return Response.json({ key, url });
  };

  const complete = async (request: Request, body: Body): Promise<Response> => {
    const upload = await target(request, body);
    if (upload instanceof Response) return upload;
    const parts = body.parts;
    if (!Array.isArray(parts) || parts.length === 0 || !parts.every(isRecord)) {
      return refuse(400, "Expected parts: [{ partNumber, eTag }].");
    }
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: upload.key,
        UploadId: upload.uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: Number(part.partNumber),
            ETag: String(part.eTag),
            ...(typeof part.checksumCRC32 === "string"
              ? { ChecksumCRC32: part.checksumCRC32 }
              : {}),
          })),
        },
      }),
    );
    return Response.json({ ok: true });
  };

  const abort = async (request: Request, body: Body): Promise<Response> => {
    const upload = await target(request, body);
    if (upload instanceof Response) return upload;
    await s3.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: upload.key,
        UploadId: upload.uploadId,
      }),
    );
    return Response.json({ ok: true });
  };

  const routes: Record<string, (request: Request, body: Body) => Promise<Response>> = {
    sign,
    single,
    complete,
    abort,
  };

  /**
   * Mount at the `baseUrl` you give httpTransport. The last path segment picks
   * the endpoint — `/sign`, `/single`, `/complete`, `/abort` — and anything else
   * is the open endpoint.
   */
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return refuse(405, "Use POST.");
    const problem = await clientProblem();
    if (problem !== null) return refuse(500, problem);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return refuse(400, "Expected a JSON body.");
    }
    if (!isRecord(body)) return refuse(400, "Expected a JSON object.");
    const segment = new URL(request.url).pathname.split("/").filter(Boolean).pop() ?? "";
    const route = routes[segment] ?? open;
    try {
      return await route(request, body);
    } catch (error) {
      // S3's message can name the bucket and key; the browser gets neither.
      console.error("presigned-multipart-upload/server:", error);
      return refuse(502, "The storage request failed.");
    }
  };
};

/**
 * The same handler for Node's http server, and Express (mount it with
 * `app.post("/api/uploads{/*rest}", toNodeHandler(handler))`, before any JSON
 * body parser, since the handler reads the body itself).
 */
export const toNodeHandler =
  (handler: (request: Request) => Promise<Response>) =>
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(", "));
    }
    const host = req.headers.host ?? "localhost";
    const response = await handler(
      new Request(new URL(req.url ?? "/", `http://${host}`), {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
