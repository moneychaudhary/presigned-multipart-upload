import { uploadError } from "./errors.js";

/** A Presigned URL, tagged with the Refresh that minted it. */
export interface PartUrl {
  value: string;
  generation: number;
}

/**
 * The Presigned URLs an Upload may currently use.
 *
 * A supply rather than a list: urls expire, so Parts draw one just before
 * sending and ask for a replacement when one is refused. Parts run concurrently
 * and their urls expire together, so Refreshes are sequenced here — one owner,
 * one Refresh per expiry however many Parts felt it.
 */
export interface PartUrls {
  /** The url for this Part now, minting more if the supply does not reach it. */
  get: (partNumber: number, signal: AbortSignal) => Promise<PartUrl>;
  /**
   * Replace urls that were not honoured. Resolves to the current generation,
   * which may already be newer if a sibling refreshed first; null when the
   * budget is spent, which means the refusal was not an expiry.
   */
  refresh: (stale: number) => Promise<number | null>;
  /** Whether a Refresh would achieve anything for a Part holding this generation. */
  canRefresh: (stale: number) => boolean;
  /**
   * A Part landed. Restores the Refresh budget, but only if it landed on the
   * current generation — an older one proves nothing about the replacements.
   */
  noteProgress: (generation: number) => void;
}

/** Obtain urls for at least the named Parts. May return more. */
export type UrlMinter = (
  partNumbers: number[],
  signal: AbortSignal,
) => Promise<Record<number, string>>;

interface PartUrlsOptions {
  partCount: number;
  mint: UrlMinter;
  /** Parts per mint. Infinity mints the whole Upload, which is what Opening does. */
  windowSize: number;
  /** Refreshes allowed before the next Part lands. Restored when one does. */
  maxRefreshes: number;
  /** Urls already in hand, in Part order — what an Opening returned. */
  seed?: readonly string[];
}

export const createPartUrls = ({
  partCount,
  mint,
  windowSize,
  maxRefreshes,
  seed,
}: PartUrlsOptions): PartUrls => {
  let generation = 0;
  let refreshesSpent = 0;
  let urls = new Map<number, string>();

  seed?.forEach((value, index) => urls.set(index + 1, value));

  /** In flight, so a burst of Parts shares one request. */
  let minting: { generation: number; done: Promise<void> } | null = null;
  /** In flight, so one expiry costs one Refresh. */
  let refreshing: Promise<number> | null = null;

  const windowFrom = (from: number): number[] => {
    const last = Number.isFinite(windowSize)
      ? Math.min(partCount, from + windowSize - 1)
      : partCount;
    const wanted: number[] = [];
    for (let partNumber = from; partNumber <= last; partNumber += 1) {
      if (!urls.has(partNumber)) wanted.push(partNumber);
    }
    return wanted;
  };

  const fill = async (partNumber: number, signal: AbortSignal): Promise<void> => {
    if (minting !== null && minting.generation === generation) {
      await minting.done;
      if (urls.has(partNumber)) return;
    }

    const at = generation;
    const done = (async () => {
      const minted = await mint(windowFrom(partNumber), signal);
      // Refreshed mid-mint: these are stale before use.
      if (generation !== at) return;
      for (const [key, value] of Object.entries(minted)) urls.set(Number(key), value);
    })();

    minting = { generation: at, done };
    try {
      await done;
    } finally {
      if (minting?.done === done) minting = null;
    }
  };

  return {
    get: async (partNumber, signal) => {
      if (!urls.has(partNumber)) await fill(partNumber, signal);

      const value = urls.get(partNumber);
      if (value === undefined) {
        throw uploadError(
          "URL_MISSING",
          `No Presigned URL was supplied for Part ${partNumber}.`,
        );
      }
      return { value, generation };
    },

    canRefresh: (stale) =>
      stale < generation || refreshing !== null || refreshesSpent < maxRefreshes,

    refresh: async (stale) => {
      // Someone met this expiry first.
      if (stale < generation) return generation;
      if (refreshing !== null) return refreshing;
      if (refreshesSpent >= maxRefreshes) return null;

      refreshesSpent += 1;
      const done = (async () => {
        generation += 1;
        urls = new Map();
        minting = null;
        return generation;
      })();

      refreshing = done;
      try {
        return await done;
      } finally {
        refreshing = null;
      }
    },

    noteProgress: (landed) => {
      if (landed === generation) refreshesSpent = 0;
    },
  };
};
