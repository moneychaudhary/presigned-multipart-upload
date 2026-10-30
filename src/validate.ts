import { uploadError } from "./errors.js";
import type { Transport, UploadFile, UploaderOptions } from "./types.js";

/**
 * Reject bad arguments at the door, naming what is wrong.
 *
 * TypeScript stops these at compile time; JavaScript callers reach them, and
 * used to meet an internal TypeError carrying no code and a stack pointing
 * into the library. Cheap checks only — shape, not semantics.
 */

const invalid = (message: string): never => {
  throw uploadError("INVALID_OPTIONS", message);
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * A File, tested structurally.
 *
 * `instanceof File` would be shorter, but the global did not exist in Node
 * before 20 and does not exist in every worker, so the check itself would throw
 * where the value is perfectly good. Everything the library does with a file is
 * here: identity for the Record, and `slice` for the Parts.
 */
export const isFileLike = (value: unknown): value is File =>
  isObject(value) &&
  typeof value.name === "string" &&
  typeof value.size === "number" &&
  typeof value.slice === "function";

const assertTransport = (transport: unknown): void => {
  if (!isObject(transport)) {
    invalid("`transport` is required: pass httpTransport({ baseUrl }) or your own implementation.");
  }
  for (const method of ["open", "complete", "abort"] as const) {
    if (typeof (transport as unknown as Transport)[method] !== "function") {
      invalid(`\`transport.${method}\` must be a function.`);
    }
  }
};

const assertFiles = (files: unknown): void => {
  if (!Array.isArray(files)) {
    invalid("`files` must be an array of File, or of { file, handle }.");
  }
  (files as UploadFile[]).forEach((entry, index) => {
    if (isFileLike(entry)) return;
    if (isObject(entry) && isFileLike(entry.file)) return;
    invalid(`\`files[${index}]\` is not a File, nor an object with a \`file\`.`);
  });
};

/** Checksums bind only when signed into the url, and only signParts is told them in time. */
const assertChecksum = (options: { checksum?: unknown; transport?: unknown }): void => {
  if (options.checksum === undefined) return;
  if (options.checksum !== "CRC32") invalid('`checksum` must be "CRC32", or left out.');
  if (typeof (options.transport as Transport).signParts !== "function") {
    invalid(
      "`checksum` needs a Transport with `signParts`: each Part's checksum must be signed into its url, and is not known until the Part is read. With httpTransport, add `paths: { sign }`.",
    );
  }
};

export const assertUploaderOptions = (options: unknown): void => {
  if (!isObject(options)) invalid("createUploader needs an options object.");
  assertTransport((options as UploaderOptions).transport);
  assertFiles((options as UploaderOptions).files);
  assertChecksum(options as UploaderOptions);
};

export const assertHttpTransportOptions = (options: unknown): void => {
  if (!isObject(options)) invalid("httpTransport needs an options object.");
  const { baseUrl } = options as { baseUrl?: unknown };
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    invalid('`baseUrl` is required, e.g. httpTransport({ baseUrl: "/api/uploads" }).');
  }
};

export const assertResumeOptions = (options: unknown): void => {
  if (!isObject(options)) invalid("resumeUploader needs an options object.");
  assertTransport((options as { transport?: unknown }).transport);
  assertChecksum(options as { checksum?: unknown; transport?: unknown });
  const { resume } = options as { resume?: unknown };
  if (resume === "all") return;
  if (!Array.isArray(resume)) {
    invalid('`resume` must be "all", or an array of { id, file? } from listResumable.');
  }
  (resume as unknown[]).forEach((spec, index) => {
    if (!isObject(spec) || typeof spec.id !== "string") {
      return invalid(`\`resume[${index}]\` must be { id, file? }, with the id listResumable gave.`);
    }
    if (spec.file !== undefined && !isFileLike(spec.file)) {
      invalid(`\`resume[${index}].file\` is not a File.`);
    }
  });
};
