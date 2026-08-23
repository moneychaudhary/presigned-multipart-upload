# Angular

```bash
npm install presigned-multipart-upload
```

One package for every framework — no `/angular` package to add, no install flag.
`@angular/core` and `rxjs` are *optional* peers, so npm does not install them;
you already have them. The binding lives at a subpath, and that import is the
only thing that touches Angular:

```ts
import { createBatch } from "presigned-multipart-upload";          // no Angular
import { createAngularUpload } from "presigned-multipart-upload/angular";
```

## `createAngularUpload`

A factory rather than an `@Injectable`, so it can be constructed and tested
without a TestBed, and so you decide whether to provide it at root, per route or
per component.

```ts
import { inject, Injectable, InjectionToken, OnDestroy } from "@angular/core";
import { createBatch, type Transport } from "presigned-multipart-upload";
import { createAngularUpload } from "presigned-multipart-upload/angular";

// Your three backend functions, provided however your app prefers.
export const UPLOAD_TRANSPORT = new InjectionToken<Transport>("UPLOAD_TRANSPORT");

@Injectable()
export class UploadService implements OnDestroy {
  private readonly transport = inject(UPLOAD_TRANSPORT);

  private upload = createAngularUpload(
    createBatch({ files: [], transport: this.transport }),
  );

  readonly snapshot = this.upload.snapshot;
  readonly snapshot$ = this.upload.snapshot$;

  start = () => this.upload.start();
  pause = () => this.upload.pause();
  resume = () => this.upload.resume();
  cancel = () => this.upload.cancel();

  ngOnDestroy() {
    this.upload.destroy();
  }
}
```

## Signals

Signals are the primary surface because they behave identically in zone-based
and zoneless applications.

```ts
@Component({
  selector: "app-uploader",
  template: `
    <progress [value]="snapshot().progress.percent" max="100"></progress>
    <span>{{ snapshot().status }}</span>

    @for (upload of snapshot().uploads; track upload.id) {
      <div>
        {{ upload.file.name }} — {{ upload.progress.percent }}%
        @if (upload.resumable) {
          <button (click)="resume()">Retry</button>
        }
      </div>
    }
  `,
})
export class UploaderComponent {
  private service = inject(UploadService);
  snapshot = this.service.snapshot;
  resume = () => this.service.resume();
}
```

Because it is a real signal, it composes:

```ts
class UploaderComponent {
  snapshot = inject(UploadService).snapshot;

  readonly failed = computed(() =>
    this.snapshot().uploads.filter((upload) => upload.status === "failed"),
  );
}
```

## RxJS interop

For codebases built on streams, `snapshot$` is a view onto the same state — not
a second source of truth.

```ts
this.upload.snapshot$
  .pipe(
    map((snapshot) => snapshot.progress.percent),
    distinctUntilChanged(),
    takeUntilDestroyed(),
  )
  .subscribe((percent) => this.progress.set(percent));
```

It emits the current snapshot immediately on subscribe, then on every change.

::: tip Pick one
Both surfaces reflect the same state. Use whichever suits the codebase; there is
no benefit to consuming both.
:::

## Cleanup

`destroy()` releases the subscription. Call it from `ngOnDestroy`. The upload
itself keeps running — it belongs to the controller, not the component — so
pause or cancel explicitly if that is what you mean.
