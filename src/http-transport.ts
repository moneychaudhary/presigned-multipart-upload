import { uploadError } from "./errors.js";
import { httpFailure } from "./failures.js";
import { assertHttpTransportOptions } from "./validate.js";
import type {
  CompleteArgs,
  FileDescriptor,
  OpenContext,
  OpenResult,
  OpenSingleContext,
  OpenSingleResult,
  SignPartsArgs,
  Transport,
  UploadTarget,
} from "./types.js";

export interface HttpTransportOptions {
  /** Base of your endpoints, e.g. "/api/uploads". */
  baseUrl: string;
  /**
   * Appended to baseUrl. Defaults: "", "/sign", "/single", "/complete",
   * "/abort" — what `presigned-multipart-upload/server` serves.
   *
   * A hand-written backend may leave two out by passing `null`:
   *
   * - `sign: null` — your open endpoint returns every url up front as `urls`.
   *   Checksums then cannot be used, since they are signed per Part.
   * - `single: null` — small files go as multipart too.
   */
  paths?: {
    open?: string;
    sign?: string | null;
    single?: string | null;
    complete?: string;
    abort?: string;
  };
  /** Static headers, or a function called per request for a fresh token. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  credentials?: RequestCredentials;
  /** Swap in your own fetch — for interceptors, or for tests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Your backend's endpoints, over JSON, done correctly.
 *
 * Every adopter would otherwise hand-write these, and the same two mistakes
 * turn up each time: `fetch` resolves on 4xx and 5xx, so an unchecked response
 * makes a failing endpoint look successful — which for `complete` marks an
 * upload finished and discards its resume record for an object that was never
 * finalised; and the abort signal never reaches the request, so cancelling
 * mid-open does not actually cancel anything.
 */
export const httpTransport = (options: HttpTransportOptions): Transport => {
  assertHttpTransportOptions(options);

  const signPath = options.paths?.sign === undefined ? "/sign" : options.paths.sign;
  const singlePath = options.paths?.single === undefined ? "/single" : options.paths.single;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/$/, "");
  const at = (path: string | undefined, fallback: string): string => `${base}${path ?? fallback}`;

  const headersFor = async (): Promise<HeadersInit> => {
    const extra =
      typeof options.headers === "function" ? await options.headers() : (options.headers ?? {});
    return { "Content-Type": "application/json", ...extra };
  };

  const post = async (url: string, body: unknown, signal?: AbortSignal): Promise<Response> => {
    const response = await doFetch(url, {
      method: "POST",
      headers: await headersFor(),
      body: JSON.stringify(body),
      credentials: options.credentials,
      signal,
    });

    // Thrown as a status-carrying failure rather than an UploadError, so the
    // Core can judge it: a 503 from your sign endpoint is worth another go,
    // and the boundary that called this names the endpoint in the error code.
    if (!response.ok) {
      throw httpFailure(
        response.status,
        `${url} responded ${response.status} ${response.statusText}`.trim(),
      );
    }
    return response;
  };

  return {
    open: async (file: FileDescriptor, ctx: OpenContext): Promise<OpenResult> => {
      const response = await post(
        at(options.paths?.open, ""),
        {
          name: file.name,
          size: file.size,
          type: file.type,
          lastModified: file.lastModified,
          partCount: ctx.partCount,
          partSize: ctx.partSize,
          // Present only when taking up an Upload that already exists.
          resumeFrom: ctx.resumeFrom,
          // Present only when checksums are on.
          checksumAlgorithm: ctx.checksumAlgorithm,
        },
        ctx.signal,
      );

      const body = (await response.json()) as Partial<OpenResult>;
      const needsUrls = signPath === null;

      if (!body?.key || !body.uploadId || (needsUrls && !Array.isArray(body.urls))) {
        throw uploadError(
          "TRANSPORT_OPEN_FAILED",
          `${at(options.paths?.open, "")} must return { key, uploadId${needsUrls ? ", urls" : ""} }.`,
        );
      }
      return {
        key: body.key,
        uploadId: body.uploadId,
        urls: Array.isArray(body.urls) ? body.urls : undefined,
      };
    },

    ...(signPath === null
      ? {}
      : {
          signParts: async (args: SignPartsArgs): Promise<Record<number, string>> => {
            const url = at(signPath, "");
            const response = await post(
              url,
              {
                key: args.key,
                uploadId: args.uploadId,
                partNumbers: args.partNumbers,
                checksumsCRC32: args.checksumsCRC32,
              },
              args.signal,
            );

            const body = (await response.json()) as { urls?: Record<string, string> };
            if (!body?.urls || typeof body.urls !== "object") {
              throw uploadError(
                "TRANSPORT_SIGN_FAILED",
                `${url} must return { urls: { [partNumber]: url } }.`,
              );
            }

            return Object.fromEntries(
              Object.entries(body.urls).map(([key, value]) => [Number(key), value]),
            );
          },
        }),

    ...(singlePath === null
      ? {}
      : {
          openSingle: async (
            file: FileDescriptor,
            ctx: OpenSingleContext,
          ): Promise<OpenSingleResult> => {
            const url = at(singlePath, "");
            const response = await post(
              url,
              {
                name: file.name,
                size: file.size,
                type: file.type,
                lastModified: file.lastModified,
                checksumCRC32: ctx.checksumCRC32,
              },
              ctx.signal,
            );
            const body = (await response.json()) as Partial<OpenSingleResult>;
            if (!body?.key || typeof body.url !== "string") {
              throw uploadError("TRANSPORT_OPEN_FAILED", `${url} must return { key, url }.`);
            }
            return { key: body.key, url: body.url };
          },
        }),

    complete: async (args: CompleteArgs) => post(at(options.paths?.complete, "/complete"), args),

    abort: async (args: UploadTarget) => post(at(options.paths?.abort, "/abort"), args),
  };
};
