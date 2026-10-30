import type { UploaderEvents, UploaderSnapshot, EventName } from "./types.js";

export interface Observable {
  subscribe: (listener: (snapshot: UploaderSnapshot) => void) => () => void;
  on: <T extends EventName>(type: T, handler: (payload: UploaderEvents[T]) => void) => () => void;
  /** Mark the snapshot stale and notify subscribers. */
  invalidate: () => void;
  emit: <T extends EventName>(type: T, payload: UploaderEvents[T]) => void;
  read: () => UploaderSnapshot;
}

/**
 * Holds the one snapshot subscribers observe, alongside the discrete events.
 *
 * Snapshots are frozen and cached: identity changes only when something actually
 * changed, so a framework binding does not re-render for nothing.
 */
export const createObservable = (build: () => UploaderSnapshot): Observable => {
  const listeners = new Set<(snapshot: UploaderSnapshot) => void>();
  const handlers = new Map<EventName, Set<(payload: never) => void>>();

  let cached: UploaderSnapshot | null = null;

  const read = (): UploaderSnapshot => {
    if (cached === null) cached = build();
    return cached;
  };

  /**
   * A subscriber that throws is the subscriber's problem, not the Upload's.
   *
   * Without this, one bad listener unwinds the Core: sibling Uploads are
   * abandoned, the settled event never fires, and the caller's start() rejects
   * for a reason that has nothing to do with the upload. The error is reported
   * rather than swallowed so it is still diagnosable.
   */
  const deliver = <T>(fn: (payload: T) => void, payload: T): void => {
    try {
      fn(payload);
    } catch (error) {
      console.error("presigned-multipart-upload: a subscriber threw", error);
    }
  };

  return {
    read,

    invalidate: () => {
      cached = null;
      // Nobody is watching, so do not pay to rebuild the tree. This runs on
      // every progress tick, and a large Upload has a lot of Parts.
      if (listeners.size === 0) return;
      const snapshot = read();
      for (const listener of [...listeners]) deliver(listener, snapshot);
    },

    subscribe: (listener) => {
      listeners.add(listener);
      // A late subscriber should not have to wait for the next change to learn
      // where things stand.
      deliver(listener, read());
      return () => {
        listeners.delete(listener);
      };
    },

    on: (type, handler) => {
      const set = handlers.get(type) ?? new Set();
      handlers.set(type, set);
      set.add(handler as (payload: never) => void);
      return () => {
        set.delete(handler as (payload: never) => void);
      };
    },

    emit: (type, payload) => {
      const set = handlers.get(type);
      if (!set) return;
      for (const handler of [...set]) deliver(handler as (p: typeof payload) => void, payload);
    },
  };
};
