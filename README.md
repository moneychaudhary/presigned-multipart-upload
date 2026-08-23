# presigned-multipart-upload

Multipart uploads to S3-compatible storage from the browser, driven by presigned
URLs your backend mints. Pause, cancel, retry with backoff, and resume from the
parts that never landed — including after a page reload.

Zero runtime dependencies. React, Vue, Angular, or nothing.

```bash
npm install presigned-multipart-upload
```

One package for every framework — it installs nothing else. React, Vue, Angular
and rxjs are optional peers. You pick your framework at the **import**:

```ts
import { createUploader } from "presigned-multipart-upload";          // core
import { useUploader } from "presigned-multipart-upload/react";
import { useUploader } from "presigned-multipart-upload/vue";
import { createUploader } from "presigned-multipart-upload/angular";  // signals + rxjs
```

---

## Quick start

```ts
import { createUploader, httpTransport } from "presigned-multipart-upload";

const uploader = createUploader({
  files: [file],
  transport: httpTransport({ baseUrl: "/api/uploads" }),
});

uploader.subscribe((snapshot) => {
  console.log(snapshot.progress.percent, snapshot.status);
});

const settled = await uploader.start();

if (settled.status === "failed") {
  await uploader.resume(); // continues from the parts that never landed
}
```

`start()` resolves when everything has settled, and does not throw — a failure is
reported on the snapshot, so one bad file cannot take the others down.

---

## Your backend

The library sends part bytes to presigned URLs. It never holds storage
credentials, so creating the upload, finalising it and tearing it down are yours.
Three endpoints:

| Endpoint | Does |
| --- | --- |
| `POST /api/uploads` | Create the multipart upload; return `{ key, uploadId, urls }` |
| `POST /api/uploads/complete` | Finalise it from the parts and ETags given |
| `POST /api/uploads/abort` | Tear it down |

```ts
app.post("/api/uploads", async (req, res) => {
  const { name, partCount, resumeFrom } = req.body;

  // A resume must reuse the upload it was given, never create a second one.
  const key = resumeFrom?.key ?? `uploads/${crypto.randomUUID()}/${name}`;
  const uploadId =
    resumeFrom?.uploadId ??
    (await s3.send(new CreateMultipartUploadCommand({ Bucket, Key: key }))).UploadId;

  const urls = await Promise.all(
    Array.from({ length: partCount }, (_, i) =>
      getSignedUrl(
        s3,
        new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: i + 1 }),
        { expiresIn: 3600 },
      ),
    ),
  );

  res.json({ key, uploadId, urls });
});

app.post("/api/uploads/complete", async (req, res) => {
  const { key, uploadId, parts } = req.body;
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.eTag })),
      },
    }),
  );
  res.json({ ok: true });
});

app.post("/api/uploads/abort", async (req, res) => {
  const { key, uploadId } = req.body;
  await s3.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
  res.json({ ok: true });
});
```

Three rules:

- **Return exactly `partCount` URLs, in part order.** Any other count is rejected
  rather than uploading to the wrong places.
- **On `resumeFrom`, return the `uploadId` you were given.** Creating a second
  upload would splice parts of two uploads into one object. The library checks.
- **Verify `resumeFrom` belongs to the caller.** It arrives from the client.

Not JSON at those paths? Implement `Transport` yourself — three functions, same
shapes.

### Bucket CORS

Without `ETag` exposed, every part fails with `MISSING_ETAG`.

```json
[{
  "AllowedOrigins": ["https://your-app.example"],
  "AllowedMethods": ["PUT"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"]
}]
```

Add a lifecycle rule to delete incomplete multipart uploads after ~7 days.
Abandoned parts are billed and do not show up in a bucket listing.

---

## Controls

```ts
const { id } = uploader.getSnapshot().uploads[0];

await uploader.pause();     // everything; pass an id for one upload
await uploader.pause(id);
await uploader.resume();
await uploader.cancel();
```

| | Stops in flight | Tells your backend to abort | Resumable |
| --- | --- | --- | --- |
| **Pause** | Yes | No | Yes |
| **Cancel** | Yes | Yes | **No — terminal** |
| **Resume** | — | — | Continues from what is missing |

Pausing is immediate, not "once the current part finishes". Take ids off the
snapshot — never construct one.

---

## Reading state

`subscribe` hands you an immutable snapshot whose identity changes only when
something changed:

```ts
const stop = uploader.subscribe((snapshot) => {
  snapshot.status;           // "idle" | "uploading" | "succeeded" | "failed" | "paused" | "cancelled"
  snapshot.progress.percent; // 0–100
  snapshot.file;             // the sole upload when there is exactly one, else null
  snapshot.uploads;          // one entry per file
});
```

Each upload carries:

```ts
upload.id;                // pass this to pause / resume / cancel
upload.file;              // { name, size, type, lastModified }
upload.status;            // "pending" | "opening" | "uploading" | "completing" | …
upload.progress.percent;
upload.parts;             // { partNumber, status, loaded, attempts, eTag }
upload.error;             // { code, message } | null
upload.resumable;         // whether resume() would do anything
upload.key, upload.uploadId;
```

Snapshots are for rendering. Moments — a toast, an analytics ping — are events:

```ts
uploader.on("part:landed", ({ id, partNumber }) => {});
uploader.on("part:retrying", ({ id, partNumber, attempt, delayMs }) => {});
uploader.on("upload:succeeded", ({ id }) => {});
uploader.on("upload:failed", ({ id, error }) => {});
uploader.on("uploader:settled", ({ status }) => {});
```

Each returns an unsubscribe function. `id` is the library's own id — not
`upload.uploadId`, which is the provider's.

---

## Frameworks

### React

```tsx
import { useMemo } from "react";
import { createUploader, httpTransport } from "presigned-multipart-upload";
import { useUploader, useUploaderEvent } from "presigned-multipart-upload/react";

const Upload = ({ files }: { files: File[] }) => {
  const uploader = useMemo(
    () => createUploader({ files, transport: httpTransport({ baseUrl: "/api/uploads" }) }),
    [files],
  );
  const { snapshot, file, start, pause, resume, cancel } = useUploader(uploader);

  useUploaderEvent(uploader, "upload:succeeded", ({ id }) => toast.success(id));

  return (
    <>
      <progress value={snapshot.progress.percent} max={100} />
      {snapshot.status === "idle" && <button onClick={start}>Upload</button>}
      {snapshot.status === "uploading" && <button onClick={() => pause()}>Pause</button>}
      {(snapshot.status === "paused" || snapshot.status === "failed") && (
        <button onClick={() => resume()}>Continue</button>
      )}
      <button onClick={() => cancel()}>Cancel</button>
    </>
  );
};
```

Built on `useSyncExternalStore`, so it re-renders when the upload moves and not
otherwise. You own the uploader's lifetime — key the memo on whatever makes a
*new* upload.

### Vue

```ts
import { useUploader } from "presigned-multipart-upload/vue";

const { snapshot, start, pause, resume, cancel } = useUploader(uploader);
// snapshot.value.progress.percent
```

### Angular

Takes the options directly — a service constructs once, so there is nothing to
own across re-renders:

```ts
import { createUploader } from "presigned-multipart-upload/angular";

@Injectable()
export class UploadService implements OnDestroy {
  private readonly upload = createUploader({ files, transport });
  readonly snapshot = this.upload.snapshot;    // Signal
  readonly snapshot$ = this.upload.snapshot$;  // Observable

  start = () => this.upload.start();
  ngOnDestroy() { this.upload.destroy(); }
}
```

`upload.uploader` is the plain uploader underneath, for `on(...)`.

### Anything else

`uploader.subscribe` calls back immediately and returns an unsubscriber, which is
the readable-store contract as-is. No adapter needed.

---

## Resuming after a reload

Two things must survive: the record of what landed, and access to the bytes. The
library always keeps the first. The second needs a file handle, or the user
choosing the file again.

```ts
import {
  createUploader, createIndexedDbStore, scopeStore,
  listResumable, resumeUploader,
} from "presigned-multipart-upload";

const store = scopeStore(createIndexedDbStore(), currentUser.id);

// Starting: pass the handle where the browser can give one.
const [handle] = await window.showOpenFilePicker();
createUploader({ files: [{ file: await handle.getFile(), handle }], transport, store });

// On the next page load:
const interrupted = await listResumable({ store });
// → [{ id, file, landedParts, totalParts, recovery: "handle" | "reselect" }]

const uploader = await resumeUploader({
  store,
  transport,
  resume: await Promise.all(
    interrupted.map(async (u) => ({
      id: u.id,
      file: u.recovery === "reselect" ? await askUserToPickAgain(u.file) : undefined,
    })),
  ),
});
await uploader.resume();
```

`resume: "all"` picks up everything recoverable without involving the user, and
skips whatever needs re-selection.

`recovery` tells you which UI to show — you never test browser support yourself.
Safari and Firefox have no file handles, nor does any browser for drag-and-drop.

A re-selected file is checked against the record by **name, size and
last-modified** before a byte is sent; a mismatch is refused with
`FINGERPRINT_MISMATCH`. Records expire after 7 days, and are removed as soon as
an upload succeeds or is cancelled.

`scopeStore` stops one person on a shared machine resuming another's upload. A
store that fails costs you durable resume and nothing else — the upload in flight
carries on.

---

## Retry, and expired URLs

Retries are automatic, with exponential backoff and full jitter. `resume()` is
the user-triggered one. The library never conflates them.

| Response | What happens |
| --- | --- |
| Network error, timeout, `429`, `5xx` | Retry with backoff |
| `403` / `401` | Refresh the URLs, then retry — expiry is the common cause |
| Other `4xx` | Fail the part |

Presigned URLs usually last an hour; a large upload does not. When they expire,
every part in flight meets it at once and they share **one** refresh between
them, so a transfer can outlive its URLs many times over. If fresh URLs are
refused too, that is a real authorisation failure and the upload ends.

While the browser reports itself offline, parts park rather than burn their retry
budget — a laptop asleep for an hour wakes with it intact.

---

## Large files

Part size is chosen per file when you do not set one: 10 MiB, or the smallest
whole MiB that keeps the file inside the provider's 10,000-part limit.

| File | Part size | Parts |
| --- | --- | --- |
| 40 MiB | 10 MiB | 4 |
| 8 GiB | 10 MiB | 820 |
| 300 GiB | 31 MiB | 9,910 |
| 2 TiB | 210 MiB | 9,987 |

Memory in flight is roughly `partSize × concurrency` — about 155 MiB for a
300 GiB file at the defaults.

**Past about a thousand parts, sign on demand.** By default `open` returns a URL
per part, which for 9,910 parts is megabytes of JSON, most of it expiring before
it is reached. Add a fourth endpoint and the library signs a window just ahead of
what it is sending:

```ts
httpTransport({ baseUrl: "/api/uploads", paths: { sign: "/sign" } });

// POST /api/uploads/sign  { key, uploadId, partNumbers: [41, 42, …] }
// →                       { urls: { 41: "https://…", 42: "https://…" } }
```

`open` then only has to return `{ key, uploadId }`, and an expired URL costs a
re-signing of the parts in flight rather than re-opening the whole upload.

---

## Options

| Option | Default | |
| --- | --- | --- |
| `files` | — | `File[]`, or `{ file, handle }[]` for durable resume |
| `transport` | — | Your open / complete / abort |
| `partSize` | per file | Bytes per part |
| `provider` | `"s3"` | `"s3"`, `"r2"`, `"b2"`, `"minio"`, `"wasabi"`, or explicit limits |
| `concurrency` | `5` | Parts in flight across all files |
| `maxRetries` | `3` | Retries per part after the first attempt |
| `retryBaseMs` | `500` | Backoff base, doubled per attempt |
| `retryMaxMs` | `15000` | Backoff ceiling |
| `partTimeoutMs` | `0` | Per-attempt timeout; `0` disables |
| `waitWhileOffline` | `true` | Park instead of retrying while offline |
| `contentType` | file's own | `Content-Type` sent with each part |
| `urlWindow` | `concurrency × 4` | Parts signed ahead, when `signParts` exists |
| `store` | — | Where records are kept; omit to lose durable resume |
| `recordTtlMs` | 7 days | How long a record stays resumable |
| `fingerprint` | all fields | Which fields must match a re-selected file |
| `classify` | built-in | Replace the rule deciding what is worth retrying |

---

## Errors

`error.code` is stable; messages are not. Branch on the code.

| Code | Means |
| --- | --- |
| `MISSING_ETAG` | **Expose `ETag` in your bucket's CORS** |
| `RETRIES_EXHAUSTED` | A part used its whole budget — offer `resume()` |
| `SEND_FAILED` | A part failed against storage |
| `EMPTY_FILE` | A file with no bytes |
| `INVALID_PART_SIZE` | Below the provider's minimum or above its maximum |
| `PART_COUNT_EXCEEDED` | Your `partSize` needs more than 10,000 parts |
| `FILE_TOO_LARGE` | Above what the provider will assemble |
| `URL_COUNT_MISMATCH` | Wrong number of URLs, or a resume opened a different upload |
| `URL_MISSING` | `signParts` skipped a part it was asked to sign |
| `TRANSPORT_OPEN_FAILED` | Your open endpoint failed |
| `TRANSPORT_COMPLETE_FAILED` | Your complete endpoint failed |
| `TRANSPORT_REQUEST_FAILED` | Your API returned non-2xx |
| `NOT_RESUMABLE` | Nothing to resume |
| `FINGERPRINT_MISMATCH` | The re-selected file is a different one |
| `FILE_REQUIRED` | Resume needs the bytes; ask the user to pick the file |
| `UNKNOWN` | Nothing recognised the failure — worth reporting |

---

MIT
