# No framework

The adapters are thin bindings over a core that is perfectly usable on its own.
Nothing is missing from this path — the adapters add no behaviour.

```ts
import { createBatch } from "presigned-multipart-upload";

const batch = createBatch({ files: [file], transport });

const unsubscribe = batch.subscribe((snapshot) => {
  bar.value = snapshot.progress.percent;
  label.textContent = snapshot.status;
});

document.querySelector("#pause")!.addEventListener("click", () => batch.pause());
document.querySelector("#retry")!.addEventListener("click", () => batch.resume());
document.querySelector("#cancel")!.addEventListener("click", () => batch.cancel());

await batch.start();
unsubscribe();
```

## The store contract

```ts
interface Observable {
  subscribe(listener: (snapshot: BatchSnapshot) => void): () => void;
  getSnapshot(): BatchSnapshot;
  on<T extends EventName>(type: T, handler: (payload: BatchEvents[T]) => void): () => void;
}
```

`subscribe` calls the listener immediately with the current snapshot, then on
every change, and returns an unsubscriber. Snapshots are frozen, and identity
changes only when something actually changed — so an equality check is enough to
decide whether to re-render.

That contract is deliberately the intersection of what `useSyncExternalStore`,
Vue's reactivity and Angular signals all want, which is why each adapter is a few
lines. It also happens to satisfy Svelte's readable-store contract exactly — a
store is just `subscribe`, so `$batch` works in a template with no adapter at
all.

## Writing your own adapter

If you are on Solid, Qwik, Lit or something else, an adapter is short:

```ts
// Solid
import { createSignal, onCleanup } from "solid-js";

export const useUpload = (controller) => {
  const [snapshot, setSnapshot] = createSignal(controller.getSnapshot());
  onCleanup(controller.subscribe(setSnapshot));
  return snapshot;
};
```

```ts
// Lit
export class UploadController {
  constructor(host, controller) {
    this.controller = controller;
    host.addController(this);
  }
  hostConnected() {
    this.dispose = this.controller.subscribe(() => this.host.requestUpdate());
  }
  hostDisconnected() {
    this.dispose?.();
  }
}
```

The rule the shipped adapters follow: **an adapter adds no behaviour**. If yours
needs to make a decision, that decision belongs in the core instead — open an
issue.
