import type { UploadErrorCode, UploadErrorInfo } from "./types.js";

/**
 * Errors carry a stable `code` so applications can branch on cause without
 * matching on message text, which changes.
 */
export class UploadError extends Error {
  override readonly name = "UploadError";
  readonly code: UploadErrorCode;

  constructor(code: UploadErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export const uploadError = (
  code: UploadErrorCode,
  message: string,
  cause?: unknown,
): UploadError => new UploadError(code, message, cause === undefined ? undefined : { cause });

/**
 * Attribute a thrown value to a cause, once, at the point that knows.
 *
 * A no-op on something already attributed, so wrapping at a boundary cannot
 * relabel an error that travelled through it. Without a single place doing this,
 * each catch site picks a code and they disagree — the same failure of
 * `transport.open` reported `TRANSPORT_OPEN_FAILED` at the start of a run and
 * `SEND_FAILED` when it happened mid-flight.
 */
export const wrap = (code: UploadErrorCode, message: string, error: unknown): UploadError =>
  error instanceof UploadError ? error : uploadError(code, `${message}: ${String(error)}`, error);

/**
 * `UNKNOWN` rather than `SEND_FAILED`: a value reaching here was not attributed
 * by anything that understood it, and calling that a send failure told adopters
 * something specific and possibly untrue.
 */
export const toErrorInfo = (error: unknown): UploadErrorInfo =>
  error instanceof UploadError
    ? { code: error.code, message: error.message }
    : { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) };

export const MISSING_ETAG_MESSAGE =
  'The response carried no readable ETag. Add "ETag" to ExposeHeaders in the bucket\'s CORS configuration.';
