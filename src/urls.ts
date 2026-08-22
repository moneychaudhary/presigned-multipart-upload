import { uploadError } from "./errors.js";

/**
 * A Presigned URL, and the Refresh that minted it.
 *
 * The generation is what makes an expiry felt by several Parts at once cost a
 * single Refresh: a Part whose Attempt failed on an older generation already
 * has fresher urls waiting, and asks for nothing.
 */
export interface PartUrl {
  value: string;
  generation: number;
}

/**
 * The Presigned URLs an Upload is currently entitled to use.
 *
 * Urls expire, so this is not a list but a supply: Parts ask for one when they
 * are about to send, and ask for the supply to be replaced when one is refused.
 * Replacing is sequenced here rather than at the call site because Parts run
 * concurrently and their urls expire together — without a single owner, N Parts
 * meeting one expiry produce N Refreshes, or worse, N-1 failures.
 */
export interface PartUrls {
  /** The url for this Part now, minting more if the supply does not reach it. */
  get: (partNumber: number, signal: AbortSignal) => Promise<PartUrl>;
  /**
   * Replace urls that were not honoured.
   *
   * Resolves to the current generation — which may already be newer than the
   * stale one, when a sibling Part met the same expiry first and refreshed on
   * everyone's behalf. Resolves to null when the Refresh budget is spent, which
   * is how a genuine authorisation failure is told apart from an expiry: an
   * expiry is fixed by fresh urls, a rejection repeats on them.
   */
  refresh: (stale: number, signal: AbortSignal) => Promise<number | null>;
  /** Whether a Refresh would achieve anything for a Part holding this generation. */
  canRefresh: (stale: number) => boolean;
  /**
   * A Part landed on this generation's urls.
   *
   * Restores the Refresh budget, but only when the generation is still the
   * current one. A Part landing on urls a sibling has already replaced proves
   * nothing about the replacements, and crediting it would let one Part that is
   * genuinely forbidden re-Open once for every sibling that happens to land.
   */
  noteProgress: (generation: number) => void;
}

/**
 * Obtain urls for the named Parts.
 *
 * May return more than was asked for — an Opening mints the whole Upload at
 * once — but must return at least what was asked for.
 */
export type UrlMinter = (
  partNumbers: number[],
  signal: AbortSignal,
) => Promise<Record<number, string>>;

export interface PartUrlsOptions {
  partCount: number;
  mint: UrlMinter;
  /**
   * How many Parts to mint at a time. Infinity mints the whole Upload in one
   * request, which is what an Opening does; a finite window is what keeps a
   * 10,000-Part Upload from signing 10,000 urls it will not use for hours.
   */
  windowSize: number;
  /**
   * Refreshes allowed before the next Part lands. A landed Part proves the
   * current urls work, so the budget is restored rather than consumed for the
   * life of the Upload — which is what lets a transfer outlive its urls many
   * times over while a genuine 403 still ends promptly.
   */
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

  /** The mint in flight, so a burst of Parts shares one request. */
  let minting: { generation: number; done: Promise<void> } | null = null;
  /** The Refresh in flight, so one expiry costs one Refresh however many Parts felt it. */
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
      // A Refresh that landed while this was in flight makes these urls stale
      // before they were ever used. Keeping them would 403 the whole window.
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
      // Someone met this expiry first. Their fresh urls are this Part's too.
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
