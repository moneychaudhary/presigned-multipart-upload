import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import type { BatchController, BatchEvents, BatchSnapshot, EventName } from "./types.js";

export interface UseUploadResult {
  snapshot: BatchSnapshot;
  /** The sole Upload, for the common case of one file. Null when not exactly one. */
  file: BatchSnapshot["file"];
  batch: BatchController;
  start: BatchController["start"];
  pause: BatchController["pause"];
  resume: BatchController["resume"];
  cancel: BatchController["cancel"];
}

/**
 * Bind a Batch to React.
 *
 * Takes a controller, as the Vue and Angular Adapters do. It used to also accept
 * the options and build the Batch itself, which read as the ergonomic path and
 * was not one: the natural call passes an array literal for `files`, whose
 * identity is fresh every render, so the Batch was rebuilt every render — the
 * exact mistake the overload existed to prevent. It only behaved if the caller
 * had already hoisted `files` to a stable reference, which is the discipline
 * `useMemo` asks for anyway. When the key did change, the previous controller
 * was dropped with no Pause and no Cancel, leaving requests in flight holding
 * Connection Budget permits nothing could release; and every option but `files`
 * was frozen at first render. Deciding when a Batch is born and dies is
 * behaviour, and CONTEXT.md puts behaviour in the Core.
 *
 * useSyncExternalStore is the right primitive underneath: the Core already
 * holds one snapshot whose identity changes only when something changed, so
 * React re-renders when the upload moves and not otherwise.
 */
export const useUpload = (controller: BatchController): UseUploadResult => {
  const snapshot = useSyncExternalStore(
    useCallback((onStoreChange: () => void) => controller.subscribe(onStoreChange), [controller]),
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return {
    snapshot,
    file: snapshot.file,
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
