import { onScopeDispose, shallowRef, type ShallowRef } from "vue";

import type { BatchController, BatchSnapshot } from "./types.js";

export interface UseUploadResult {
  snapshot: ShallowRef<BatchSnapshot>;
  start: BatchController["start"];
  pause: BatchController["pause"];
  resume: BatchController["resume"];
  cancel: BatchController["cancel"];
  stop: () => void;
}

/**
 * Bind a Batch to Vue's reactivity.
 *
 * shallowRef rather than ref: snapshots are already frozen and replaced whole,
 * so deep reactivity would walk every Part on every progress tick to discover
 * what the identity change told us for free.
 */
export const useUpload = (controller: BatchController): UseUploadResult => {
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
