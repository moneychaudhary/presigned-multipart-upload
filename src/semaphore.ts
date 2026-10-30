import { abortFailure } from "./failures.js";

export interface Semaphore {
  /**
   * Wait for a slot. `owner` names who is asking — an Upload's id — so freed
   * slots can be shared out in turn rather than first-come. Rejects, and leaves
   * the queue, if `signal` aborts while waiting: a paused Upload must not sit
   * in line for a slot it will never use, nor hold up the Pause until one frees.
   */
  acquire: (owner?: string, signal?: AbortSignal) => Promise<() => void>;
}

/**
 * A counting semaphore that takes turns between owners, written here rather
 * than taken from a package because the Core ships no runtime dependencies.
 *
 * Turns, because the Budget is shared across the Batch and a first-come queue
 * is not a fair share of it: a large file queues all of its Parts the moment it
 * Opens, and a small file Opened a moment later would wait behind every one of
 * them. Round-robin gives each Upload with work waiting the next slot in turn.
 */
export const createSemaphore = (limit: number): Semaphore => {
  const size = Math.max(1, Math.floor(limit));
  const queues = new Map<string, Array<() => void>>();
  /** Owners with someone waiting, in the order they are next served. */
  const turns: string[] = [];
  let active = 0;

  const release = (): void => {
    const owner = turns.shift();
    if (owner === undefined) {
      active -= 1;
      return;
    }
    const queue = queues.get(owner)!;
    const next = queue.shift()!;
    // Back of the line, if it still has work waiting.
    if (queue.length > 0) turns.push(owner);
    else queues.delete(owner);
    // Hand the slot straight over rather than freeing it and resolving. A
    // resolved promise only schedules a microtask, so a slot given up and not
    // yet retaken is a window in which a fresh acquire sees room and takes it —
    // putting one more request in flight than the Budget allows. Surplus
    // requests do not fail loudly; they queue beneath the network layer and can
    // time out having never been sent.
    next();
  };

  return {
    acquire: async (owner = "", signal) => {
      if (signal?.aborted) throw abortFailure("Stopped while waiting for a connection");
      if (active >= size) {
        // The slot is already accounted for by whoever handed it over, so this
        // must not increment on waking.
        await new Promise<void>((resolve, reject) => {
          const wake = (): void => {
            signal?.removeEventListener("abort", leave);
            resolve();
          };
          const leave = (): void => {
            const queue = queues.get(owner);
            const index = queue?.indexOf(wake) ?? -1;
            if (queue === undefined || index === -1) return; // already handed a slot
            queue.splice(index, 1);
            if (queue.length === 0) {
              queues.delete(owner);
              turns.splice(turns.indexOf(owner), 1);
            }
            reject(abortFailure("Stopped while waiting for a connection"));
          };
          signal?.addEventListener("abort", leave, { once: true });
          const queue = queues.get(owner);
          if (queue === undefined) {
            queues.set(owner, [wake]);
            turns.push(owner);
          } else {
            queue.push(wake);
          }
        });
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
