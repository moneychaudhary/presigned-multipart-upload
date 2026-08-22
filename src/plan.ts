import { uploadError } from "./errors.js";
import type { PartSnapshot } from "./types.js";

export interface PlanOptions {
  size: number;
  partSize: number;
  minPartSize: number;
  maxParts: number;
}

/**
 * Divide a file into Parts.
 *
 * Throws rather than returning a partial plan, so that a file which cannot be
 * uploaded is rejected before the Transport is troubled to Open anything.
 */
export const planParts = ({ size, partSize, minPartSize, maxParts }: PlanOptions): PartSnapshot[] => {
  if (size <= 0) {
    throw uploadError("EMPTY_FILE", "A file with no bytes cannot be uploaded as multipart.");
  }

  if (partSize < minPartSize) {
    throw uploadError(
      "INVALID_PART_SIZE",
      `Part size ${partSize} is below the provider minimum of ${minPartSize}.`,
    );
  }

  const partCount = Math.ceil(size / partSize);

  if (partCount > maxParts) {
    throw uploadError(
      "PART_COUNT_EXCEEDED",
      `A file of ${size} bytes needs ${partCount} Parts, above the provider limit of ${maxParts}. Use a larger Part size.`,
    );
  }

  return Array.from({ length: partCount }, (_, index) => {
    const start = index * partSize;
    const end = Math.min(start + partSize, size);
    return {
      partNumber: index + 1,
      start,
      end,
      size: end - start,
      status: "pending" as const,
      loaded: 0,
      attempts: 0,
      eTag: null,
    };
  });
};
