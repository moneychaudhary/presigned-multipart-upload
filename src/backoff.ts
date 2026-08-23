/**
 * Exponential backoff with full jitter.
 *
 * Full jitter — random across the whole window rather than base plus random —
 * is what stops a set of Parts that all failed on one dropped connection from
 * retrying in lockstep and dropping it again.
 */
export const backoffDelay = (
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number => Math.round(random() * Math.min(maxMs, baseMs * 2 ** attempt));
