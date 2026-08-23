import { signal, type Signal } from "@angular/core";
import { Observable } from "rxjs";

import { toUploader, type UploaderSource } from "./uploader.js";
import type { Uploader, UploaderSnapshot } from "./types.js";

export interface AngularUploader {
  /** Live state, for templates and computed signals. */
  snapshot: Signal<UploaderSnapshot>;
  /** The same state as a stream, for codebases built on RxJS. */
  snapshot$: Observable<UploaderSnapshot>;
  /** The Uploader itself, for `on` and anything else off the core surface. */
  uploader: Uploader;
  start: Uploader["start"];
  pause: Uploader["pause"];
  resume: Uploader["resume"];
  cancel: Uploader["cancel"];
  /** Release the subscription. Call from the service's ngOnDestroy. */
  destroy: () => void;
}

/**
 * Build an Uploader bound to Angular.
 *
 * Give it the options and it builds the Uploader; hand it an Uploader instead
 * when several services must share one. A factory rather than an @Injectable,
 * so it needs no TestBed and you choose where to provide it. Signals are the
 * primary surface — they behave the same zoned and zoneless; `snapshot$` is a
 * view onto the same state, not a second source of truth.
 */
export const createUploader = (source: UploaderSource): AngularUploader => {
  const controller = toUploader(source);
  const state = signal<UploaderSnapshot>(controller.getSnapshot());
  const unsubscribe = controller.subscribe((next) => state.set(next));

  // subscribe() already replays the current snapshot to a new listener, so
  // pushing it here as well would emit the initial state twice.
  const snapshot$ = new Observable<UploaderSnapshot>((subscriber) =>
    controller.subscribe((next) => subscriber.next(next)),
  );

  return {
    snapshot: state.asReadonly(),
    snapshot$,
    uploader: controller,
    start: controller.start,
    pause: controller.pause,
    resume: controller.resume,
    cancel: controller.cancel,
    destroy: unsubscribe,
  };
};
