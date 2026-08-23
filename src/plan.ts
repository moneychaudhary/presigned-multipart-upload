import { uploadError } from "./errors.js";
import type { PartSnapshot } from "./types.js";

const MIB = 1024 * 1024;

/** The Part size auto-sizing settles on when the file does not force a larger one. */
const PREFERRED_PART_SIZE = 10 * MIB;

export interface PlanOptions {
  size: number;
  /** "auto" derives a size from the file and the provider's limits. */
  partSize: number | "auto";
  minPartSize: number;
  maxParts: number;
  maxPartSize: number;
  maxObjectSize: number;
}

export interface Plan {
  /** The size actually used, which the Upload Record must carry for Resume. */
  partSize: number;
  parts: PartSnapshot[];
}

/**
 * Choose a Part size for one file.
 *
 * A fixed Part size cannot serve every file: the provider caps how many Parts
 * an upload may have, so beyond `partSize x maxParts` bytes the only way to
 * proceed is larger Parts. This takes the preferred size as a floor and grows
 * it only as far as the file forces.
 */
export const autoPartSize = ({
  size,
  minPartSize,
  maxParts,
  maxPartSize,
}: Omit<PlanOptions, "partSize" | "maxObjectSize">): number => {
  const forcedByPartLimit = Math.ceil(size / maxParts);
  const wanted = Math.max(PREFERRED_PART_SIZE, minPartSize, forcedByPartLimit);
  // Whole MiB, so Part boundaries stay legible in logs and in the bucket.
  return Math.min(Math.ceil(wanted / MIB) * MIB, maxPartSize);
};

/**
 * Cut a file into Part-sized byte ranges.
 *
 * Just the arithmetic — no provider limits, no choosing. A Resume wants exactly
 * this and nothing else, because the size it must use was settled by the run it
 * is taking up and is carried on the Upload Record.
 */
export const sliceParts = (size: number, partSize: number): PartSnapshot[] =>
  Array.from({ length: Math.ceil(size / partSize) }, (_, index) => {
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

/**
 * Divide a file into Parts.
 *
 * Throws rather than returning a partial plan, so that a file which cannot be
 * uploaded is rejected before the Transport is troubled to Open anything.
 */
export const planParts = ({
  size,
  partSize,
  minPartSize,
  maxParts,
  maxPartSize,
  maxObjectSize,
}: PlanOptions): Plan => {
  if (size <= 0) {
    throw uploadError("EMPTY_FILE", "A file with no bytes cannot be uploaded as multipart.");
  }

  if (size > maxObjectSize) {
    throw uploadError(
      "FILE_TOO_LARGE",
      `A file of ${size} bytes is above the provider limit of ${maxObjectSize} for a single object.`,
    );
  }

  const resolved =
    partSize === "auto"
      ? autoPartSize({ size, minPartSize, maxParts, maxPartSize })
      : partSize;

  if (resolved < minPartSize) {
    throw uploadError(
      "INVALID_PART_SIZE",
      `Part size ${resolved} is below the provider minimum of ${minPartSize}.`,
    );
  }

  if (resolved > maxPartSize) {
    throw uploadError(
      "INVALID_PART_SIZE",
      `Part size ${resolved} is above the provider maximum of ${maxPartSize}.`,
    );
  }

  const partCount = Math.ceil(size / resolved);

  if (partCount > maxParts) {
    throw uploadError(
      "PART_COUNT_EXCEEDED",
      `A file of ${size} bytes needs ${partCount} Parts of ${resolved} bytes, above the provider limit of ${maxParts}. Leave partSize unset to have one chosen, or raise it.`,
    );
  }

  return { partSize: resolved, parts: sliceParts(size, resolved) };
};
