import { getCurrentScope, onScopeDispose, shallowReadonly, shallowRef, type ShallowRef } from "vue";

import { toUploader, type UploaderSource } from "./uploader.js";
import type { Uploader, UploaderSnapshot } from "./types.js";

export interface VueUploader {
  /** Live state for templates and computed values; read-only, holds the Core's own object. */
  snapshot: Readonly<ShallowRef<UploaderSnapshot>>;
  /** The Uploader itself, for `on` and anything else off the core surface. */
  uploader: Uploader;
  start: Uploader["start"];
  pause: Uploader["pause"];
  resume: Uploader["resume"];
  cancel: Uploader["cancel"];
  /** Release the subscription. */
  dispose: () => void;
}

// Inside setup() or effectScope().run(), release when the scope stops; outside, the caller does.
const bindToScope = (release: () => void): void => {
  if (getCurrentScope()) onScopeDispose(release);
};

export const useUploader = (source: UploaderSource): VueUploader => {
  const controller = toUploader(source);
  const state = shallowRef(controller.getSnapshot());
  const dispose = controller.subscribe((next) => {
    state.value = next;
  });
  bindToScope(dispose);
  return {
    snapshot: shallowReadonly(state),
    uploader: controller,
    start: controller.start,
    pause: controller.pause,
    resume: controller.resume,
    cancel: controller.cancel,
    dispose,
  };
};
