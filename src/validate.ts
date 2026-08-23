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

export const assertUploaderOptions = (options: unknown): void => {
  if (!isObject(options)) invalid("createUploader needs an options object.");
  assertTransport((options as UploaderOptions).transport);
  assertFiles((options as UploaderOptions).files);
};

export const assertHttpTransportOptions = (options: unknown): void => {
  if (!isObject(options)) invalid("httpTransport needs an options object.");
  const { baseUrl } = options as { baseUrl?: unknown };
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    invalid('`baseUrl` is required, e.g. httpTransport({ baseUrl: "/api/uploads" }).');
  }
};
