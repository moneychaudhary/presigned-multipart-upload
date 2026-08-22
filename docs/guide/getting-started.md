# Getting started

## Install

```bash
npm install presigned-multipart-upload
```

There are no runtime dependencies. Framework bindings are optional peers, so
importing the core pulls in nothing.

## The two halves

This library uploads bytes. It does not sign anything, and it never holds your
storage credentials — which means **you must implement three functions on your
own backend** before anything works. Those three functions are the Transport, and
they are covered in full in [the backend contract](/guide/backend-contract).

Everything below assumes they exist.

## The short version

If your backend speaks JSON at three conventional endpoints, that is the whole
client:

```ts
import { createBatch, httpTransport } from "presigned-multipart-upload";

const batch = createBatch({
  files: [...selectedFiles],
  transport: httpTransport({ baseUrl: "/api/uploads" }),
});

batch.subscribe((snapshot) => render(snapshot));

const settled = await batch.start();
if (settled.status === "failed") await batch.resume();
```

`httpTransport` posts to `/api/uploads`, `/api/uploads/complete` and
`/api/uploads/abort`, checks every response, and passes the abort signal
through. Point it elsewhere with `paths`, and add auth with `headers`:

```ts
httpTransport({
  baseUrl: "/api/uploads",
  paths: { complete: "/finish", abort: "/cancel" },
  // A function is called per request, so a refreshed token is picked up.
  headers: () => ({ Authorization: `Bearer ${auth.token()}` }),
});
```

## Writing the transport yourself

Use this when your API does not fit the shape above. The three functions are all
the library needs; see [the backend contract](/guide/backend-contract) for what
each must do.

```ts
const transport = {
  open: async (file, ctx) => {
    const response = await fetch("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        partCount: ctx.partCount,
        resumeFrom: ctx.resumeFrom,
      }),
      signal: ctx.signal,
    });
    // fetch resolves on 4xx and 5xx; without this a failing endpoint looks
    // like success, and a "successful" complete discards the resume record.
    if (!response.ok) throw new Error(`open failed: ${response.status}`);
    return response.json();
  },
  complete: async (args) => { /* POST, and check response.ok */ },
  abort: async (args) => { /* POST */ },
};
```

## What you get back

`start()`, `resume()`, `pause()` and `cancel()` all resolve to a snapshot, and
`subscribe()` hands you the same shape whenever it changes:

```ts
interface BatchSnapshot {
  status: "idle" | "uploading" | "succeeded" | "failed" | "cancelled" | "paused";
  progress: { loaded: number; total: number; percent: number };
  uploads: UploadSnapshot[];
}

interface UploadSnapshot {
  id: string;
  file: { name: string; size: number; type: string; lastModified: number };
  status:
    | "pending" | "opening" | "uploading" | "completing"
    | "succeeded" | "failed" | "cancelled" | "paused";
  progress: { loaded: number; total: number; percent: number };
  parts: PartSnapshot[];
  key: string | null;
  uploadId: string | null;
  error: { code: string; message: string } | null;
  /** True when a Resume would have work to do. */
  resumable: boolean;
}

interface PartSnapshot {
  partNumber: number;
  start: number;
  end: number;
  size: number;
  status: "pending" | "uploading" | "landed" | "failed";
  loaded: number;
  attempts: number;
  eTag: string | null;
}
```

Snapshots are frozen, and their identity only changes when something actually
changed — so binding one straight to a render is cheap.

## States, not moments

Some things are states you render, and some are moments you react to once.
Rendering "upload failed" from a snapshot is right; firing a toast from one is
not, because you would fire it on every subsequent render too. Moments are
events:

```ts
batch.on("part:landed", ({ uploadId, partNumber }) => {});
batch.on("part:retrying", ({ partNumber, attempt, delayMs }) => {});
batch.on("upload:succeeded", ({ uploadId }) => {});
batch.on("upload:failed", ({ uploadId, error }) => {});
batch.on("upload:cancelled", ({ uploadId }) => {});
batch.on("upload:paused", ({ uploadId }) => {});
batch.on("batch:settled", ({ status }) => {});
```

Each returns an unsubscribe function.

## One file is a batch of one

There is no separate single-file API. Pass one file and the batch has one
upload, and reach it with `file()` rather than indexing:

```ts
const batch = createBatch({ files: [file], transport });
await batch.start();

snapshot.file?.progress.percent; // the sole upload, or null
snapshot.file?.status;
```

`file()` throws if the batch holds anything other than exactly one upload.

## Before you ship

Two pieces of bucket configuration are not optional, and both fail in confusing
ways when missing:

- **Expose the `ETag` header via CORS**, or parts upload successfully and
  finalising then rejects them.
- **Set a lifecycle rule to abort incomplete multipart uploads**, because this
  library deliberately leaves failed uploads open so they can be resumed.

Both are covered in [bucket setup](/guide/bucket-setup).

## Next

- [The backend contract](/guide/backend-contract) — the three functions you implement
- [Retry and backoff](/guide/retry) — what is retried, and how to tune it
- [Cancel, pause and resume](/guide/lifecycle) — and why cancel is not pause
- [Durable resume](/guide/durable-resume) — surviving a page reload
- Your framework: [React](/adapters/react), [Angular](/adapters/angular), [Vue](/adapters/vue), or [none at all](/adapters/vanilla)
