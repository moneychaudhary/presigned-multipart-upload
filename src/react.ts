import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import type { Uploader, UploaderEvents, UploaderSnapshot, EventName } from "./types.js";

export interface UseUploaderResult {
  snapshot: UploaderSnapshot;
  /** The sole Upload, for the common case of one file. Null when not exactly one. */
  file: UploaderSnapshot["file"];
  uploader: Uploader;
  start: Uploader["start"];
  pause: Uploader["pause"];
  resume: Uploader["resume"];
  cancel: Uploader["cancel"];
}

/**
 * Bind an Uploader to React.
 *
 * Takes a controller, as the Vue and Angular Adapters do — own its lifetime with
 * `useMemo`, keyed on whatever makes a *new* upload. Built on
 * useSyncExternalStore: the Core holds one snapshot whose identity changes only
 * when something changed, so this re-renders when the upload moves and not
 * otherwise.
 */
export const useUploader = (controller: Uploader): UseUploaderResult => {
  const snapshot = useSyncExternalStore(
    useCallback((onStoreChange: () => void) => controller.subscribe(onStoreChange), [controller]),
    controller.getSnapshot,
    controller.getSnapshot,
  );

  return {
    snapshot,
    file: snapshot.file,
    uploader: controller,
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
export const useUploaderEvent = <T extends EventName>(
  controller: Uploader,
  type: T,
  handler: (payload: UploaderEvents[T]) => void,
): void => {
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => controller.on(type, (payload) => latest.current(payload)), [controller, type]);
};
