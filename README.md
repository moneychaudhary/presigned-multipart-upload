# presigned-multipart-upload

Multipart uploads to S3-compatible storage from the browser. Your backend mints
presigned URLs; this handles the parts — retrying, pausing, cancelling, and
resuming from what never landed, including after a page reload.

- **Zero dependencies.** React, Vue and Angular are optional peers.
- **Never holds your credentials.** It only ever PUTs to URLs you signed.
- **Resumes by default.** What landed is remembered across reloads.

```bash
npm install presigned-multipart-upload
```

One package for every framework. Pick yours at the import:

```ts
import { createUploader } from "presigned-multipart-upload";           // core
import { useUploader } from "presigned-multipart-upload/react";
import { useUploader } from "presigned-multipart-upload/vue";
import { createUploader } from "presigned-multipart-upload/angular";
```

---

## Quick start

```ts
import { createUploader, httpTransport } from "presigned-multipart-upload";

const uploader = createUploader({
  files: [file],
  transport: httpTransport({ baseUrl: "/api/uploads" }),
});

uploader.subscribe(({ progress, status }) => render(progress.percent, status));

const settled = await uploader.start();
if (settled.status === "failed") await uploader.resume();
```

`start()` never throws — a failure lands on the snapshot, so one bad file cannot
take the others down. `httpTransport` calls three endpoints you write; see
[Your backend](#your-backend).

---

## Frameworks

Every adapter takes the same options as `createUploader` and owns the uploader
for you. Hand it one you built yourself when several components share it.

### React

```tsx
import { httpTransport } from "presigned-multipart-upload";
import { useUploader } from "presigned-multipart-upload/react";

const Upload = ({ files }: { files: File[] }) => {
  const { snapshot, start, pause, resume, cancel } = useUploader({
    files,
    transport: httpTransport({ baseUrl: "/api/uploads" }),
  });

  return (
    <>
      <progress value={snapshot.progress.percent} max={100} />
      {snapshot.status === "idle" && <button onClick={start}>Upload</button>}
      {snapshot.status === "uploading" && <button onClick={() => pause()}>Pause</button>}
      {snapshot.status === "paused" && <button onClick={() => resume()}>Continue</button>}
      <button onClick={() => cancel()}>Cancel</button>
    </>
  );
};
```

Rebuilt only when the file list changes, so keep your files in state — a new set
of files is a new upload, and nothing else is. Holding a `File` costs a pointer,
not the bytes, so a 2 TiB file in state is fine.

For events, take `uploader` off the result and pass it to `useUploaderEvent`:

```tsx
const { uploader } = useUploader({ files, transport });
useUploaderEvent(uploader, "upload:succeeded", ({ id }) => toast.success(id));
```

### Vue

```ts
import { useUploader } from "presigned-multipart-upload/vue";

const { snapshot, start, pause, resume, cancel } = useUploader({ files, transport });
// snapshot.value.progress.percent
```

### Angular

```ts
import { createUploader } from "presigned-multipart-upload/angular";

@Injectable()
export class UploadService implements OnDestroy {
  private upload = createUploader({ files, transport });
  snapshot = this.upload.snapshot;    // Signal
  snapshot$ = this.upload.snapshot$;  // Observable

  start = () => this.upload.start();
  ngOnDestroy() { this.upload.destroy(); }
}
```

### No framework

`uploader.subscribe` calls back immediately and returns an unsubscriber — the
readable-store contract as it stands. No adapter needed.

---

## Controls

```ts
await uploader.pause();     // all of them; pass an id for one
await uploader.resume();
await uploader.cancel();
```

| | Stops in flight | Aborts at your backend | Resumable |
| --- | --- | --- | --- |
| **Pause** | Yes | No | Yes |
| **Cancel** | Yes | Yes | No — terminal |

Pausing is immediate, not "after the current part". Take ids from the snapshot;
never construct one.

---

## Progress and events

```ts
uploader.subscribe((s) => {
  s.status;           // idle | uploading | succeeded | failed | paused | cancelled
  s.progress.percent; // 0–100
  s.file;             // the sole upload, when there is exactly one
  s.uploads;          // { id, file, status, progress, parts, error, resumable, key, uploadId }
});
```

Snapshots are for rendering. Moments are events:

```ts
uploader.on("part:retrying", ({ partNumber, attempt, delayMs }) => {});
uploader.on("upload:succeeded", ({ id }) => {});
uploader.on("upload:failed", ({ id, error }) => {});
```

Also `part:landed`, `upload:paused`, `upload:cancelled` and `uploader:settled`.
Each returns an unsubscriber. `id` is the library's own — not `uploadId`, which
is the provider's.

Statuses, events and error codes ship as constants, so a typo is a compile error
instead of a branch that never runs:

```ts
import { UploaderStatus, UploadEvent, UploadErrorCode } from "presigned-multipart-upload";

if (snapshot.status === UploaderStatus.Succeeded) celebrate();

uploader.on(UploadEvent.UploadFailed, ({ error }) => {
  if (error.code === UploadErrorCode.MissingETag) fixYourCors();
});
```

---

## Resume after a reload

The record of what landed is kept for you, in IndexedDB. Only the bytes need
help, because a browser cannot hold a file across a reload on its own:

```ts
import { listResumable, resumeUploader } from "presigned-multipart-upload";

const interrupted = await listResumable();
// [{ id, file, landedParts, totalParts, recovery: "handle" | "reselect" }]

const uploader = await resumeUploader({
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

`recovery` tells you which UI to show — you never test browser support yourself.
Pass a handle when you start and Chrome-family browsers skip the picker entirely:

```ts
// showOpenFilePicker is not in TypeScript's DOM lib yet:
// npm i -D @types/wicg-file-system-access
const [handle] = await window.showOpenFilePicker();
createUploader({ files: [{ file: await handle.getFile(), handle }], transport });
```

`resume: "all"` then picks up everything recoverable without involving the user.
A re-selected file is checked by name, size and last-modified before a byte is
sent. Records expire after 7 days and are dropped the moment an upload succeeds.

On a shared machine, scope the store so one person cannot resume another's:

```ts
import { createIndexedDbStore, scopeStore } from "presigned-multipart-upload";

createUploader({ files, transport, store: scopeStore(createIndexedDbStore(), user.id) });
```

Pass `store: null` to keep no records at all.

---

## Retries

Automatic, with exponential backoff and full jitter. `resume()` is the
user-triggered one; the two are never conflated.

| Response | What happens |
| --- | --- |
| Network error, timeout, `429`, `5xx` | Retry with backoff |
| `403` / `401` | Refresh the URLs once, then retry — expiry is the usual cause |
| Other `4xx` | Fail that part |

Presigned URLs last an hour; a large upload does not. When they expire, every
part in flight meets it at once and they share **one** refresh, so a transfer can
outlive its URLs many times over. While the browser reports itself offline,
parts park instead of burning their retry budget.

---

## Your backend

The library PUTs bytes to presigned URLs. Creating the upload, finalising it and
tearing it down are yours — three endpoints:

| Endpoint | Does |
| --- | --- |
| `POST /api/uploads` | Create it; return `{ key, uploadId, urls }` |
| `POST /api/uploads/complete` | Finalise it from the parts and ETags given |
| `POST /api/uploads/abort` | Tear it down |

Three rules:

- **Return exactly `partCount` URLs, in part order.** Any other count is refused
  rather than uploaded to the wrong place.
- **On `resumeFrom`, reuse the `uploadId` you were given.** A second upload would
  splice parts of two into one object. The library checks.
- **Verify `resumeFrom` belongs to the caller.** It arrives from the client.

Not JSON at those paths? Implement `Transport` yourself — three functions, same
shapes.

### Node

```ts
app.post("/api/uploads", async (req, res) => {
  const { name, partCount, resumeFrom } = req.body;

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

### Python

```python
import uuid
import boto3
from fastapi import FastAPI

s3 = boto3.client("s3")
app = FastAPI()
BUCKET = "your-bucket"


@app.post("/api/uploads")
def open_upload(body: dict):
    resume = body.get("resumeFrom")
    key = resume["key"] if resume else f"uploads/{uuid.uuid4()}/{body['name']}"
    upload_id = (
        resume["uploadId"]
        if resume
        else s3.create_multipart_upload(Bucket=BUCKET, Key=key)["UploadId"]
    )

    urls = [
        s3.generate_presigned_url(
            "upload_part",
            Params={"Bucket": BUCKET, "Key": key, "UploadId": upload_id, "PartNumber": n},
            ExpiresIn=3600,
        )
        for n in range(1, body["partCount"] + 1)
    ]

    return {"key": key, "uploadId": upload_id, "urls": urls}


@app.post("/api/uploads/complete")
def complete(body: dict):
    s3.complete_multipart_upload(
        Bucket=BUCKET,
        Key=body["key"],
        UploadId=body["uploadId"],
        MultipartUpload={
            "Parts": [
                {"PartNumber": p["partNumber"], "ETag": p["eTag"]} for p in body["parts"]
            ]
        },
    )
    return {"ok": True}


@app.post("/api/uploads/abort")
def abort(body: dict):
    s3.abort_multipart_upload(Bucket=BUCKET, Key=body["key"], UploadId=body["uploadId"])
    return {"ok": True}
```

### Bucket CORS

Without `ETag` exposed, **every part fails** with `MISSING_ETAG`.

```json
[{
  "AllowedOrigins": ["https://your-app.example"],
  "AllowedMethods": ["PUT"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"]
}]
```

Add a lifecycle rule deleting incomplete multipart uploads after ~7 days.
Abandoned parts are billed and never show up in a bucket listing.

---

## Large files

Part size is chosen per file unless you set one: 10 MiB, or the smallest whole
MiB that keeps the file inside the provider's 10,000-part limit.

| File | Part size | Parts |
| --- | --- | --- |
| 40 MiB | 10 MiB | 4 |
| 8 GiB | 10 MiB | 820 |
| 300 GiB | 31 MiB | 9,910 |
| 2 TiB | 210 MiB | 9,987 |

Memory in flight is about `partSize × concurrency` — 155 MiB for that 300 GiB
file at the defaults, whatever the file's size.

### Signing on demand

Past a thousand parts or so, returning every URL from `open` is megabytes of
JSON, most of it expiring before it is reached. Add a fourth endpoint and the
library asks for URLs in batches, just ahead of what it is sending:

```ts
httpTransport({ baseUrl: "/api/uploads", paths: { sign: "/sign" } });

// POST /api/uploads/sign  { key, uploadId, partNumbers: [41, 42, … 60] }
// →                       { urls: { 41: "https://…", 42: "https://…" } }
```

`open` then returns only `{ key, uploadId }` — drop its URL loop.

```ts
app.post("/api/uploads/sign", async (req, res) => {
  const { key, uploadId, partNumbers } = req.body;

  const entries = await Promise.all(
    partNumbers.map(async (partNumber) => [
      partNumber,
      await getSignedUrl(
        s3,
        new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: 3600 },
      ),
    ]),
  );

  res.json({ urls: Object.fromEntries(entries) });
});
```

```python
@app.post("/api/uploads/sign")
def sign(body: dict):
    return {
        "urls": {
            n: s3.generate_presigned_url(
                "upload_part",
                Params={
                    "Bucket": BUCKET,
                    "Key": body["key"],
                    "UploadId": body["uploadId"],
                    "PartNumber": n,
                },
                ExpiresIn=3600,
            )
            for n in body["partNumbers"]
        }
    }
```

Sign every number you are given; extras are kept and reused, a missing one fails
that part with `URL_MISSING`. The batch size is `urlWindow` — 9,910 parts is
~500 sign calls at the default and 10 at `urlWindow: 1000`. Neither end has a
cliff: a batch that outlives its URLs costs one shared re-sign, not the upload.

---

## Options

| Option | Default | |
| --- | --- | --- |
| `files` | — | `File[]`, or `{ file, handle }[]` for handle-based resume |
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
| `urlWindow` | `concurrency × 4` | Parts signed per batch, when `signParts` exists |
| `store` | IndexedDB | Where records are kept; `null` for none |
| `recordTtlMs` | 7 days | How long a record stays resumable |
| `fingerprint` | all fields | Which fields must match a re-selected file |
| `classify` | built-in | Replace the rule deciding what is worth retrying |

---

## Errors

`error.code` is stable; messages are not. Branch on the code.

| Code | Means |
| --- | --- |
| `MISSING_ETAG` | **Expose `ETag` in your bucket's CORS** |
| `INVALID_OPTIONS` | An argument to `createUploader` or `httpTransport` was the wrong shape |
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

Requires Node 20+ when used outside a browser. MIT.
