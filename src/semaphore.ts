export interface Semaphore {
  acquire: () => Promise<() => void>;
  readonly limit: number;
}

/**
 * A counting semaphore, written here rather than taken from a package because
 * the Core ships no runtime dependencies.
 */
export const createSemaphore = (limit: number): Semaphore => {
  const size = Math.max(1, Math.floor(limit));
  const waiting: Array<() => void> = [];
  let active = 0;

  const release = (): void => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };

  return {
    limit: size,
    acquire: async () => {
      if (active >= size) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
      };
    },
  };
};

/**
 * Divide a fixed request budget between concurrently active Uploads.
 *
 * Browsers cap simultaneous connections per host. Going over the cap does not
 * fail loudly — the surplus queues below the network layer, where it reports no
 * progress and can time out having never been sent. Shrinking each Upload's
 * share as more become active keeps every Part the Core believes is in flight
 * actually on the wire.
 */
export const partConcurrencyFor = (activeUploads: number, budget: number): number => {
  if (activeUploads <= 0) return budget;
  if (activeUploads > budget) return 1;
  return budget - activeUploads + 1;
};
