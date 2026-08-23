import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { createUploader, type UploaderSource } from "./uploader.js";
import type { Uploader, UploaderEvents, UploaderSnapshot, UploadFile, EventName } from "./types.js";

export interface UseUploaderResult {
  snapshot: UploaderSnapshot;
  /** The sole Upload, for the common case of one file. Null when not exactly one. */
  file: UploaderSnapshot["file"];
  /** The Uploader itself, for `on` and to hand to a child component. */
  uploader: Uploader;
  start: Uploader["start"];
  pause: Uploader["pause"];
  resume: Uploader["resume"];
  cancel: Uploader["cancel"];
}

const sameFiles = (a: UploadFile[], b: UploadFile[]): boolean =>
  a.length === b.length && a.every((entry, index) => entry === b[index]);

/**
 * Bind an Uploader to React.
 *
 * Give it the options and it owns the Uploader, rebuilding only when the file
 * list changes — which is what makes a *different* upload, so it is the only
 * honest key. Every other option is read once, at that moment. Hand it an
 * Uploader instead when several components must share one.
 *
 * Built on useSyncExternalStore: the Core holds one snapshot whose identity
 * changes only when something changed, so this re-renders when the upload moves
 * and not otherwise.
 */
export const useUploader = (source: UploaderSource): UseUploaderResult => {
  // Called unconditionally, whichever form `source` takes, because hook order
  // may not depend on an argument.
  const owned = useRef<{ files: UploadFile[]; uploader: Uploader } | null>(null);

  let controller: Uploader;
  if ("getSnapshot" in source) {
    controller = source;
  } else {
    if (owned.current === null || !sameFiles(owned.current.files, source.files)) {
      owned.current = { files: source.files, uploader: createUploader(source) };
    }
    controller = owned.current.uploader;
  }

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
 * Takes the Uploader, not the options — `useUploader(...).uploader` is it. This
 * runs every render, so building one here would build a new one every render.
 * The handler is held in a ref so that passing an inline arrow — which every
 * caller will do — does not tear the subscription down and rebuild it.
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
