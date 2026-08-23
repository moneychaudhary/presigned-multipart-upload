import { uploadError } from "./errors.js";
import { assertHttpTransportOptions } from "./validate.js";
import type {
  CompletedPart,
  FileDescriptor,
  OpenContext,
  OpenResult,
  SignPartsArgs,
  Transport,
} from "./types.js";

export interface HttpTransportOptions {
  /** Base of your three endpoints, e.g. "/api/uploads". */
  baseUrl: string;
  /**
   * Appended to baseUrl. Defaults: "", "/complete", "/abort".
   *
   * `sign` has no default: supply it only if your backend can sign named Parts,
   * and the library will then sign a window ahead instead of asking Opening for
   * every url at once. Worth it once Uploads run to thousands of Parts.
   */
  paths?: { open?: string; complete?: string; abort?: string; sign?: string };
  /** Static headers, or a function called per request for a fresh token. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  credentials?: RequestCredentials;
  /** Swap in your own fetch — for interceptors, or for tests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The three backend calls, over JSON, done correctly.
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

  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/$/, "");
  const at = (path: string | undefined, fallback: string): string =>
    `${base}${path ?? fallback}`;

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

    if (!response.ok) {
      throw uploadError(
        "TRANSPORT_REQUEST_FAILED",
        `${url} responded ${response.status} ${response.statusText}`,
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
        },
        ctx.signal,
      );

      const body = (await response.json()) as Partial<OpenResult>;
      const needsUrls = options.paths?.sign === undefined;

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

    ...(options.paths?.sign === undefined
      ? {}
      : {
          signParts: async (args: SignPartsArgs): Promise<Record<number, string>> => {
            const url = at(options.paths?.sign, "");
            const response = await post(
              url,
              { key: args.key, uploadId: args.uploadId, partNumbers: args.partNumbers },
              args.signal,
            );

            const body = (await response.json()) as { urls?: Record<string, string> };
            if (!body?.urls || typeof body.urls !== "object") {
              throw uploadError(
                "URL_MISSING",
                `${url} must return { urls: { [partNumber]: url } }.`,
              );
            }

            return Object.fromEntries(
              Object.entries(body.urls).map(([key, value]) => [Number(key), value]),
            );
          },
        }),

    complete: async (args: { key: string; uploadId: string; parts: CompletedPart[] }) =>
      post(at(options.paths?.complete, "/complete"), args),

    abort: async (args: { key: string; uploadId: string }) =>
      post(at(options.paths?.abort, "/abort"), args),
  };
};
