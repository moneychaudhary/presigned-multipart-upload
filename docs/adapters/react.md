# React

```bash
npm install presigned-multipart-upload
```

React is an optional peer dependency — importing the core never pulls it in.

## `useUpload`

Pass the options and the hook owns the batch — there is no `useMemo` to forget:

```tsx
import { useUpload } from "presigned-multipart-upload/react";

const Uploader = ({ files }: { files: File[] }) => {
  const { snapshot, file, start, pause, resume, cancel } = useUpload({ files, transport });

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

`useUpload` also accepts an existing controller if you need to own it yourself —
`useUpload(batch)` — and returns it as `batch` either way.

`file` is the sole upload's snapshot when the batch holds exactly one, or `null`
otherwise, which saves indexing into `snapshot.uploads[0]` for the common case.

## `useUploadEvent`

Snapshots are for rendering state. Some things are moments rather than states —
firing a toast, sending an analytics ping — and rendering those from a snapshot
fires them again on every subsequent render.

```tsx
import { useUploadEvent } from "presigned-multipart-upload/react";

useUploadEvent(batch, "upload:succeeded", ({ uploadId }) => {
  toast.success(`${uploadId} finished`);
});

useUploadEvent(batch, "part:retrying", ({ partNumber, delayMs }) => {
  console.log(`part ${partNumber} retrying in ${delayMs}ms`);
});
```

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
