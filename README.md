# presigned-multipart-upload

Multipart uploads to presigned URLs that retry themselves, park when the network
drops, and resume from the parts that never landed — in any framework, with no
runtime dependencies.

```bash
npm install presigned-multipart-upload
```

```ts
import { createBatch } from "presigned-multipart-upload";

const batch = createBatch({
  files: [file],
  transport: {
    // ctx.signal is passed through, not into the body, so cancelling
    // mid-open actually aborts the request.
    open: (file, { partCount, resumeFrom, signal }) =>
      api.post("/uploads", { name: file.name, partCount, resumeFrom }, { signal }),
    complete: (args) => api.post("/uploads/complete", args),
    abort: (args) => api.post("/uploads/abort", args),
  },
});

batch.subscribe(({ status, progress }) => render(status, progress.percent));

const settled = await batch.start();
if (settled.status === "failed") await batch.resume(); // picks up what is missing
```

## Why

Uploading a large file from a browser is a solved problem right up until
something goes wrong, and something always goes wrong: a laptop sleeps, a train
enters a tunnel, a proxy resets a connection, a presigned URL expires while four
gigabytes are still in flight, someone closes the tab at 90%.

Most implementations fail the whole file when one part drops, tear the upload
down on first error so the bytes that *did* land are discarded, and mint their
URLs once so a long upload cannot outlive them.

This is the machinery for the part after "it works on a good connection".

## What it does

- **Retries transient failures** with exponential backoff and full jitter, on a
  per-part budget. Failures that cannot succeed on a retry fail immediately
  instead of working through the ladder.
- **Parks when offline** rather than spending the retry budget, and wakes when
  connectivity returns.
- **Recovers from expired URLs** by re-opening for fresh ones, repeatedly if a
  long upload needs it — while a genuine authorisation failure still terminates.
- **Leaves failed uploads open** so a single `resume()` continues from the parts
  that never landed, with earlier ETags intact.
- **Survives a page reload**, via a File System Access handle where the browser
  supports one and re-selection with a fingerprint check where it does not.
- **Cancels immediately** and tears down at the provider, distinctly from pause,
  which keeps the upload alive.
- **Respects the browser's connection cap** by sharing one budget across the
  whole batch, so many files cannot silently stall each other.

## What it does not do

- Sign anything. It consumes presigned URLs; it never holds your credentials.
- Depend on a storage SDK, or on anything else at runtime.
- Ship UI. No drop zones, no progress bars — just state to render.

You implement three functions on your own backend — open, complete, abort — and
the library does the rest. See
[the backend contract](https://moneychaudhary.github.io/presigned-multipart-upload/guide/backend-contract),
which walks through it in both Node and Python.

## Frameworks

```ts
import { useUpload } from "presigned-multipart-upload/react";
import { createAngularUpload } from "presigned-multipart-upload/angular";
import { useUpload } from "presigned-multipart-upload/vue";
```

All optional peers — importing the core pulls in no framework. The core works
perfectly on its own.

## Before you ship

Two pieces of bucket configuration, both of which fail confusingly when missing:

- **Expose the `ETag` header via CORS**, or parts upload fine and finalising
  then rejects them.
- **Set a lifecycle rule to abort incomplete multipart uploads** — this library
  deliberately leaves failed uploads open so they can be resumed, and nothing
  cleans them up for you.

## Documentation

**[moneychaudhary.github.io/presigned-multipart-upload](https://moneychaudhary.github.io/presigned-multipart-upload/)**

Guides for the backend contract, bucket setup, retry tuning, the lifecycle verbs
and durable resume; a page per adapter; and a full options and error reference.

```bash
npm run docs:dev   # or run it locally
```

## Development

```bash
npm test              # 143 tests, no network, no container
npm run typecheck
npm run build
npm run test:integration   # needs MinIO; see npm run minio:up
```

## Licence

MIT
