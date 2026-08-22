import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import type { BatchController, BatchEvents, BatchSnapshot, EventName } from "./types.js";

export interface UseUploadResult {
  snapshot: BatchSnapshot;
  start: BatchController["start"];
  pause: BatchController["pause"];
  resume: BatchController["resume"];
  cancel: BatchController["cancel"];
}

/**
 * Bind a Batch to React.
 *
 * useSyncExternalStore is the right primitive here rather than useState in an
 * effect: the Core already holds one immutable snapshot whose identity changes
 * only when something changed, which is exactly the contract this hook wants —
 * so React re-renders when the upload moves and not otherwise.
 */
export const useUpload = (controller: BatchController): UseUploadResult => {
  const snapshot = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => controller.subscribe(onStoreChange),
      [controller],
    ),
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return {
    snapshot,
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

  useEffect(
    () => controller.on(type, (payload) => latest.current(payload)),
    [controller, type],
  );
};
