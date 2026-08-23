import { UploadError } from "./errors.js";

export type RetryVerdict =
  /** Transient. Back off and attempt the same Presigned URL again. */
  | "retry"
  /** The URL has probably expired. Open again for fresh urls, then retry once. */
  | "reopen"
  /** Attempting again cannot help. */
  | "fatal";

export interface ClassifyContext {
  /** True once this Upload has already been re-Opened for this failure. */
  alreadyReopened: boolean;
}

const statusOf = (error: unknown): number | null => {
  // A Platform may throw anything, including null — reading a property off it
  // would throw here and replace the real failure with a TypeError.
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
};

const nameOf = (error: unknown): string =>
  error instanceof Error ? error.name : "";

export type Classifier = (error: unknown, ctx: ClassifyContext) => RetryVerdict;

/**
 * The default rule for whether a failed Attempt is worth repeating.
 *
 * A 403 is treated as an expired Presigned URL rather than as a permission
 * problem, because expiry is overwhelmingly the more common cause mid-upload —
 * but only once, so a genuine authorisation failure still terminates.
 */
export const defaultClassifier: Classifier = (error, { alreadyReopened }) => {
  // Our own errors are decisive: they describe conditions repetition cannot fix.
  if (error instanceof UploadError) return "fatal";

  const name = nameOf(error);
  if (name === "AbortError") return "fatal";
  if (name === "NetworkError" || name === "TimeoutError") return "retry";

  const status = statusOf(error);
  if (status !== null) {
    if (status === 429 || status >= 500) return "retry";
    if (status === 403 || status === 401) return alreadyReopened ? "fatal" : "reopen";
    return "fatal";
  }

  // An unrecognised throw is treated as transient rather than quietly ending
  // an upload that might well have succeeded on a second try.
  return "retry";
};
