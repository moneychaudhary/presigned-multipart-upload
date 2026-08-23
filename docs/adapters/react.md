# React

```bash
npm install presigned-multipart-upload
```

That is the whole install, for every framework — one package, no dependencies,
and nothing framework-specific. There is no separate `/react` package to add and
no install flag to pass. React is an *optional* peer, so npm does not pull it in;
you already have it.

The binding lives at a subpath, and that import is the only thing that touches
React:

```ts
import { createBatch } from "presigned-multipart-upload";        // no React
import { useUpload } from "presigned-multipart-upload/react";    // React
```

Import only the core and React never enters your bundle — the package is marked
side-effect free, so bundlers drop what you did not reach for.

## `useUpload`

Pass the options and the hook owns the batch — there is no `useMemo` to forget:

```tsx
import { useMemo } from "react";
import { createBatch } from "presigned-multipart-upload";
import { useUpload } from "presigned-multipart-upload/react";

const Uploader = ({ files }: { files: File[] }) => {
  const batch = useMemo(() => createBatch({ files, transport }), [files]);
  const { snapshot, file, start, pause, resume, cancel } = useUpload(batch);

  return (
    <div>
      <progress value={snapshot.progress.percent} max={100} />
      <span>{snapshot.status}</span>

      {snapshot.status === "idle" && <button onClick={start}>Upload</button>}
      {snapshot.status === "uploading" && <button onClick={() => pause()}>Pause</button>}
      {snapshot.status === "paused" && <button onClick={() => resume()}>Continue</button>}
      {snapshot.status === "failed" && <button onClick={() => resume()}>Retry</button>}
      <button onClick={() => cancel()}>Cancel</button>

      <ul>
        {snapshot.uploads.map((upload) => (
          <li key={upload.id}>
            {upload.file.name} — {upload.progress.percent}% — {upload.status}
            {upload.error && <em> {upload.error.message}</em>}
          </li>
        ))}
      </ul>
    </div>
  );
};
```

The hook is built on `useSyncExternalStore`. The core already holds one
immutable snapshot whose identity changes only when something changed, which is
exactly what that primitive wants — so the component re-renders when the upload
moves and not otherwise.

`useUpload` takes a controller, as the Vue and Angular bindings do, and returns
it as `batch`. Own the batch yourself with `useMemo` — keyed on whatever makes a
*new* upload, usually the file selection.

The hook deliberately does not build the batch for you. It used to, and the
natural call passed an array literal for `files`, whose identity is fresh on
every render — so it rebuilt the batch every render, which is the exact mistake
it existed to prevent. Deciding when a batch is born and dies is your call.

`file` is the sole upload's snapshot when the batch holds exactly one, or `null`
otherwise, which saves indexing into `snapshot.uploads[0]` for the common case.
It comes straight off `snapshot.file`, so every binding — and Svelte, which needs
none — has it.

## `useUploadEvent`

Snapshots are for rendering state. Some things are moments rather than states —
firing a toast, sending an analytics ping — and rendering those from a snapshot
fires them again on every subsequent render.

```tsx
import { useUploadEvent } from "presigned-multipart-upload/react";

useUploadEvent(batch, "upload:succeeded", ({ id }) => {
  toast.success(`${id} finished`);
});

useUploadEvent(batch, "part:retrying", ({ partNumber, delayMs }) => {
  console.log(`part ${partNumber} retrying in ${delayMs}ms`);
});
```

Every event payload carries `id` — the library's own identifier for the upload,
the one `resume`, `pause` and `cancel` take. It is *not* `uploadId`, which on a
snapshot means the storage provider's multipart id.

The handler is held in a ref, so passing an inline arrow — which everyone does —
does not tear the subscription down and rebuild it on every render.

## Per-part detail

```tsx
{upload.parts.map((part) => (
  <li key={part.partNumber}>
    Part {part.partNumber}: {part.status}
    {part.attempts > 1 && ` (attempt ${part.attempts})`}
  </li>
))}
```

## Cleanup

The subscription is released on unmount. An upload in flight keeps going — it is
owned by the controller, not the component. To stop it when the component goes
away, do so explicitly:

```tsx
useEffect(() => () => void batch.pause(), [batch]);
```

Prefer `pause` to `cancel` here: a component unmounting is usually navigation,
not a decision to discard the work.
