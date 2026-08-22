export interface Semaphore {
  acquire: () => Promise<() => void>;
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
    const next = waiting.shift();
    // Hand the slot straight over rather than freeing it and resolving. A
    // resolved promise only schedules a microtask, so a slot given up and not
    // yet retaken is a window in which a fresh acquire sees room and takes it —
    // putting one more request in flight than the Budget allows. Surplus
    // requests do not fail loudly; they queue beneath the network layer and can
    // time out having never been sent.
    if (next) {
      next();
      return;
    }
    active -= 1;
  };

  return {
    acquire: async () => {
      if (active >= size) {
        // The slot is already accounted for by whoever handed it over, so this
        // must not increment on waking.
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        active += 1;
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
      };
    },
  };
};
