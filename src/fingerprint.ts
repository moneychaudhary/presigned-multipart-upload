import { uploadError } from "./errors.js";
import type { FileDescriptor } from "./types.js";

export interface FingerprintOptions {
  /** Compare the file's name. Default true. */
  name?: boolean;
  /** Compare the byte count. Default true. */
  size?: boolean;
  /** Compare the last-modified time. Default true. */
  lastModified?: boolean;
}

const FIELDS = ["name", "size", "lastModified"] as const;

/**
 * Decide whether bytes offered for a Resume are the same file the Upload Record
 * describes.
 *
 * Metadata only, deliberately: hashing a multi-gigabyte file on every Resume
 * would cost more than it protects. What this catches is the realistic mistake —
 * a user asked to re-select after a reload picking the wrong file — and that is
 * enough to keep Parts of two different files out of one object.
 */
export const fingerprintMismatch = (
  expected: FileDescriptor,
  offered: FileDescriptor,
  options: FingerprintOptions = {},
): (typeof FIELDS)[number] | null => {
  for (const field of FIELDS) {
    if (options[field] === false) continue;
    if (expected[field] !== offered[field]) return field;
  }
  return null;
};

export const assertFingerprint = (
  expected: FileDescriptor,
  offered: FileDescriptor,
  options?: FingerprintOptions,
): void => {
  const field = fingerprintMismatch(expected, offered, options);
  if (field === null) return;
  throw uploadError(
    "FINGERPRINT_MISMATCH",
    `The selected file does not match the interrupted Upload: ${field} differs ` +
      `(expected ${String(expected[field])}, got ${String(offered[field])}).`,
  );
};
