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
