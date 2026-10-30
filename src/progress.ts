import type { Progress } from "./types.js";

/** How far back the speed looks. Long enough to smooth Part boundaries, short enough to follow a change of network. */
const WINDOW_MS = 5_000;

/** Below this much elapsed time a speed is noise, so none is reported. */
const MIN_SPAN_MS = 500;

interface Sample {
  at: number;
  loaded: number;
}

/**
 * Bytes per second over a sliding window of (time, bytes) samples.
 *
 * Fed only from the Platform clock, so it is as deterministic as everything
 * else in the Core. It measures what progress reports — bytes counted once,
 * never twice for a Retry — so a flaky connection reads as slow, which is the
 * truth an ETA needs.
 */
export interface RateMeter {
  sample: (at: number, loaded: number) => void;
  /**
   * Bytes per second, or null when there is not yet enough to say — or when
   * nothing has been heard for a whole window, because a stalled transfer has
   * no speed worth showing.
   */
  rate: (now: number) => number | null;
  /** Forget everything, so time spent stopped is never averaged in. */
  reset: () => void;
}

export const createRateMeter = (): RateMeter => {
  let samples: Sample[] = [];

  return {
    sample: (at, loaded) => {
      samples.push({ at, loaded });
      // Keep the newest sample older than the window, so the span covers it.
      while (samples.length > 2 && samples[1]!.at <= at - WINDOW_MS) samples.shift();
    },
    rate: (now) => {
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (first === undefined || last === undefined) return null;
      if (now - last.at > WINDOW_MS) return null;
      const span = last.at - first.at;
      const moved = last.loaded - first.loaded;
      // Nothing new in the whole window is a stall, not a speed of zero.
      if (span < MIN_SPAN_MS || moved <= 0) return null;
      return Math.round((moved / span) * 1000);
    },
    reset: () => {
      samples = [];
    },
  };
};

const percentOf = (loaded: number, total: number): number =>
  total === 0 ? 0 : Math.round((loaded / total) * 10_000) / 100;

/** Time left at the current speed. Null when there is no speed to go on. */
const remainingAt = (
  loaded: number,
  total: number,
  bytesPerSecond: number | null,
): number | null =>
  bytesPerSecond === null || bytesPerSecond <= 0
    ? null
    : Math.ceil(((total - loaded) / bytesPerSecond) * 1000);

export const progressOf = (
  loaded: number,
  total: number,
  bytesPerSecond: number | null = null,
  /** Bytes still to send, when not all of `total - loaded` is going to move. */
  outstanding: number = total - loaded,
): Progress =>
  Object.freeze({
    loaded,
    total,
    percent: percentOf(loaded, total),
    bytesPerSecond,
    remainingMs: remainingAt(total - outstanding, total, bytesPerSecond),
  });
