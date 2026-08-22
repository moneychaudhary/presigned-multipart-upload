import { signal, type Signal } from "@angular/core";
import { Observable } from "rxjs";

import type { BatchController, BatchSnapshot } from "./types.js";

export interface AngularUpload {
  /** Live Batch state, for templates and computed signals. */
  snapshot: Signal<BatchSnapshot>;
  /** The same state as a stream, for codebases built on RxJS. */
  snapshot$: Observable<BatchSnapshot>;
  start: BatchController["start"];
  pause: BatchController["pause"];
  resume: BatchController["resume"];
  cancel: BatchController["cancel"];
  /** Release the subscription. Call from the service's ngOnDestroy. */
  destroy: () => void;
}

/**
 * Bind a Batch to Angular.
 *
 * A factory rather than an @Injectable class, so it can be constructed and
 * tested without a TestBed, and so an application can decide for itself whether
 * to provide it at root, per route, or per component. Wrap it in a service:
 *
 *   @Injectable()
 *   export class UploadService implements OnDestroy {
 *     private readonly upload = createAngularUpload(createBatch({ ... }));
 *     readonly snapshot = this.upload.snapshot;
 *     ngOnDestroy() { this.upload.destroy(); }
 *   }
 *
 * Signals are the primary surface because they work the same in zone-based and
 * zoneless applications; the Observable is a view onto the identical state
 * rather than a second source of truth.
 */
export const createAngularUpload = (controller: BatchController): AngularUpload => {
  const state = signal<BatchSnapshot>(controller.getSnapshot());
  const unsubscribe = controller.subscribe((next) => state.set(next));

  // subscribe() already replays the current snapshot to a new listener, so
  // pushing it here as well would emit the initial state twice.
  const snapshot$ = new Observable<BatchSnapshot>((subscriber) =>
    controller.subscribe((next) => subscriber.next(next)),
  );

  return {
    snapshot: state.asReadonly(),
    snapshot$,
    start: controller.start,
    pause: controller.pause,
    resume: controller.resume,
    cancel: controller.cancel,
    destroy: unsubscribe,
  };
};
