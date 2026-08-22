# React

```bash
npm install presigned-multipart-upload
```

React is an optional peer dependency — importing the core never pulls it in.

## `useUpload`

```tsx
import { createBatch } from "presigned-multipart-upload";
import { useUpload } from "presigned-multipart-upload/react";
import { useMemo } from "react";

const Uploader = ({ files }: { files: File[] }) => {
  // Memoise the controller: a new one on every render would restart everything.
  const batch = useMemo(() => createBatch({ files, transport }), [files]);
  const { snapshot, start, pause, resume, cancel } = useUpload(batch);

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

::: warning Memoise the controller
`createBatch` starts a new batch. Calling it in a render body without
`useMemo` creates a fresh one every render and nothing will ever finish.
:::

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
