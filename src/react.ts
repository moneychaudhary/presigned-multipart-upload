import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { createBatch } from "./batch.js";
import type {
  BatchController,
  BatchEvents,
  BatchOptions,
  BatchSnapshot,
  EventName,
} from "./types.js";

export interface UseUploadResult {
  snapshot: BatchSnapshot;
  /** The sole Upload, for the common case of one file. Null when not exactly one. */
  file: BatchSnapshot["uploads"][number] | null;
  batch: BatchController;
  start: BatchController["start"];
  pause: BatchController["pause"];
  resume: BatchController["resume"];
  cancel: BatchController["cancel"];
}

const isController = (source: BatchController | BatchOptions): source is BatchController =>
  "subscribe" in source;

/**
 * Bind a Batch to React.
 *
 * Accepts either an existing controller or the options to build one. Passing
 * options is the ergonomic path: `createBatch` in a render body without
 * `useMemo` builds a new Batch every render and nothing ever finishes, and that
 * mistake is easy to make and hard to see. Here the controller is created once
 * and kept until `files` changes.
 *
 * useSyncExternalStore is the right primitive underneath: the Core already
 * holds one snapshot whose identity changes only when something changed, so
 * React re-renders when the upload moves and not otherwise.
 */
export const useUpload = (source: BatchController | BatchOptions): UseUploadResult => {
  const held = useRef<{ key: unknown; controller: BatchController } | null>(null);
  const key = isController(source) ? source : source.files;

  if (held.current === null || held.current.key !== key) {
    held.current = {
      key,
      controller: isController(source) ? source : createBatch(source),
    };
  }
  const controller = held.current.controller;

  const snapshot = useSyncExternalStore(
    useCallback((onStoreChange: () => void) => controller.subscribe(onStoreChange), [controller]),
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return {
    snapshot,
    file: snapshot.uploads.length === 1 ? snapshot.uploads[0]! : null,
    batch: controller,
    start: controller.start,
    pause: controller.pause,
    resume: controller.resume,
    cancel: controller.cancel,
  };
};

/**
 * Subscribe to a lifecycle event for as long as the component is mounted.
 *
 * The handler is held in a ref so that passing an inline arrow — which every
 * caller will do — does not tear the subscription down and rebuild it on every
 * render.
 */
export const useUploadEvent = <T extends EventName>(
  controller: BatchController,
  type: T,
  handler: (payload: BatchEvents[T]) => void,
): void => {
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => controller.on(type, (payload) => latest.current(payload)), [controller, type]);
};
