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

## A complete client

```ts
import { createBatch } from "presigned-multipart-upload";

const json = { "Content-Type": "application/json" };

// fetch resolves on 4xx and 5xx. Without this, a failing endpoint looks like
// success — and a complete that "succeeds" marks the upload done and discards
// its resume record for an object that was never finalised.
const ok = async (response: Response) => {
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response;
};

const transport = {
  // Open a multipart upload and hand back one presigned URL per part.
  open: async (file, ctx) => {
    const response = await fetch("/api/uploads", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: file.name,
        size: file.size,
        type: file.type,
        partCount: ctx.partCount,
        // Present only when taking up an upload that already exists.
        resumeFrom: ctx.resumeFrom,
      }),
      // Pass the signal through so cancelling mid-open actually aborts.
      signal: ctx.signal,
    });
    return (await ok(response)).json(); // { key, uploadId, urls }
  },

  complete: async ({ key, uploadId, parts }) =>
    ok(
      await fetch("/api/uploads/complete", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ key, uploadId, parts }),
      }),
    ),

  abort: async ({ key, uploadId }) =>
    fetch("/api/uploads/abort", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ key, uploadId }),
    }),
};

const batch = createBatch({ files: [...selectedFiles], transport });

const unsubscribe = batch.subscribe((snapshot) => {
  render(snapshot); // status, progress, per-upload and per-part detail
});

const settled = await batch.start();

if (settled.status === "failed") {
  // Nothing was thrown away. Pick up from the parts that never landed.
  await batch.resume();
}

unsubscribe();
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
upload; nothing else changes.

```ts
const batch = createBatch({ files: [file], transport });
```

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
