import { onScopeDispose, shallowRef, type ShallowRef } from "vue";

import type { Uploader, UploaderSnapshot } from "./types.js";

export interface UseUploaderResult {
  snapshot: ShallowRef<UploaderSnapshot>;
  start: Uploader["start"];
  pause: Uploader["pause"];
  resume: Uploader["resume"];
  cancel: Uploader["cancel"];
  stop: () => void;
}

/**
 * Bind an Uploader to Vue's reactivity.
 *
 * shallowRef rather than ref: snapshots are already frozen and replaced whole,
 * so deep reactivity would walk every Part on every progress tick to discover
 * what the identity change told us for free.
 */
export const useUploader = (controller: Uploader): UseUploaderResult => {
  const snapshot = shallowRef(controller.getSnapshot());
  const unsubscribe = controller.subscribe((next) => {
    snapshot.value = next;
  });

  // Ties the subscription to the owning effect scope where there is one, so a
  // component that unmounts mid-upload does not keep re-rendering nothing.
  onScopeDispose(unsubscribe, true);

  return {
    snapshot,
    start: controller.start,
    pause: controller.pause,
    resume: controller.resume,
    cancel: controller.cancel,
    stop: unsubscribe,
  };
};
