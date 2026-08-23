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
 * Attribute a thrown value to a cause, at the boundary that knows it. A no-op on
 * something already attributed, so wrapping cannot relabel an error in transit.
 */
export const wrap = (code: UploadErrorCode, message: string, error: unknown): UploadError =>
  error instanceof UploadError ? error : uploadError(code, `${message}: ${String(error)}`, error);

/** `UNKNOWN`, not `SEND_FAILED`: nothing here understood what failed. */
export const toErrorInfo = (error: unknown): UploadErrorInfo =>
  error instanceof UploadError
    ? { code: error.code, message: error.message }
    : { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) };

export const MISSING_ETAG_MESSAGE =
  'The response carried no readable ETag. Add "ETag" to ExposeHeaders in the bucket\'s CORS configuration.';
