import type { Uploader } from "./types.js";

/** The controls every framework binding hands back unchanged from the Core. */
export interface UploaderActions {
  start: Uploader["start"];
  pause: Uploader["pause"];
  resume: Uploader["resume"];
  cancel: Uploader["cancel"];
}

/** Pick the controls off an Uploader, for a binding to spread into its result. */
export const actionsOf = (controller: Uploader): UploaderActions => ({
  start: controller.start,
  pause: controller.pause,
  resume: controller.resume,
  cancel: controller.cancel,
});
