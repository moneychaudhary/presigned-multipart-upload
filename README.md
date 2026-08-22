# presigned-multipart-upload

Multipart uploads to presigned URLs that retry themselves, park when the network
drops, and resume from the parts that never landed — in any framework, with no
runtime dependencies.

```bash
npm install presigned-multipart-upload
```

**Contents** · [Why](#why) · [Quick start](#quick-start) · [Backend contract](#the-backend-contract) · [What you get back](#what-you-get-back) · [Cancel, pause, resume](#cancel-pause-and-resume) · [Retry](#retry-and-backoff) · [Durable resume](#durable-resume) · [Very large files](#very-large-files) · [Frameworks](#frameworks) · [Options](#options) · [Errors](#errors) · [Bucket setup](#bucket-setup) · [Glossary](#glossary)

---

## Why

Uploading a large file from a browser is a solved problem right up until
something goes wrong, and something always goes wrong: a laptop sleeps, a train
enters a tunnel, a proxy resets a connection, a presigned URL expires while four
gigabytes are still in flight, someone closes the tab at 90%.

Most implementations fail the whole file when one part drops, tear the upload
down on first error so the bytes that *did* land are discarded, and mint their
URLs once so a long upload cannot outlive them.

This is the machinery for the part after "it works on a good connection".

**What it does**

- **Retries transient failures** with exponential backoff and full jitter, on a
  per-part budget. Failures that cannot succeed on a retry fail immediately.
- **Parks when offline** rather than spending the retry budget, and wakes when
  connectivity returns.
- **Recovers from expired URLs** by re-opening for fresh ones, repeatedly if a
  long upload needs it — while a genuine authorisation failure still terminates.
- **Leaves failed uploads open** so one `resume()` continues from the parts that
  never landed, with earlier ETags intact.
- **Survives a page reload**, via a File System Access handle where the browser
  supports one and re-selection with a fingerprint check where it does not.
- **Cancels immediately** and tears down at the provider — distinctly from pause,
  which keeps the upload alive.
- **Respects the browser's connection cap** with one queue across the whole batch.

**What it does not do**

- Sign anything. It consumes presigned URLs; it never holds your credentials.
- Depend on a storage SDK, or on anything else at runtime.
- Ship UI. No drop zones, no progress bars — just state to render.

---

## Quick start

If your backend speaks JSON at three conventional endpoints, this is the whole
client:

```ts
import { createBatch, httpTransport } from "presigned-multipart-upload";

const batch = createBatch({
  files: [...selectedFiles],
  transport: httpTransport({ baseUrl: "/api/uploads" }),
});

batch.subscribe((snapshot) => render(snapshot));

const settled = await batch.start();
if (settled.status === "failed") {
  await batch.resume(); // picks up from the parts that never landed
}
```

`httpTransport` posts to `/api/uploads`, `/api/uploads/complete` and
`/api/uploads/abort`, checks every response, and passes the abort signal through.

```ts
httpTransport({
  baseUrl: "/api/uploads",
  paths: { complete: "/finish", abort: "/cancel" },
  // A function is called per request, so a refreshed token is picked up.
  headers: () => ({ Authorization: `Bearer ${auth.token()}` }),
  credentials: "include",
});
```

**One file is a batch of one.** There is no separate single-file API; reach the
sole upload with `file()`:

```ts
const batch = createBatch({ files: [file], transport });
await batch.start();

batch.file().progress.percent;
batch.file().status;
```

---

## The backend contract

The library sends part bytes to presigned URLs. It does not sign them, create
the multipart upload, or finalise it. Those three things are yours, because they
are where authorisation, quota and object naming belong.

```ts
interface Transport {
  open(file, ctx): Promise<{ key: string; uploadId: string; urls?: string[] }>;
  // Optional; see "Very large files". Signs only the parts named.
  signParts?({ key, uploadId, partNumbers, signal }): Promise<Record<number, string>>;
  complete({ key, uploadId, parts }): Promise<unknown>;
  abort({ key, uploadId }): Promise<unknown>;
}
```

### `open`

Called on **two occasions**, and always told which:

```ts
open(file, { partCount, partSize, resumeFrom, signal })
```

- **`resumeFrom` undefined** — create a new multipart upload, return its id.
- **`resumeFrom` present** — do *not* create a second one. Return the `uploadId`
  you were given plus a **fresh** set of presigned URLs for the same upload.

Both occasions must return usable URLs: a URL minted an hour ago may not be
honoured now, and re-opening is how a long upload survives its own URL expiry.

> **`urls.length` must equal `partCount`.** Too few and parts have nowhere to go;
> too many usually means a stale list, which would misalign every part. Both are
> rejected before any byte is sent.

> **Verify `resumeFrom` before trusting it.** It arrives from the client. Check
> the key belongs to the caller, or one user could obtain signed write access to
> another's upload.

### `complete`

Called once every part has landed. Parts arrive **sorted ascending**, each with
the ETag the provider returned, quotes included.

### `abort`

Called when an upload is **cancelled**. It is *not* called when retries run out —
that upload is deliberately left open so it can be resumed. See
[bucket setup](#bucket-setup).

### Node

```ts
import {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "us-east-1" });

app.post("/api/uploads", async (req, res) => {
  const { name, size, partCount, resumeFrom } = req.body;
  await assertQuota(req.user, size);

  if (resumeFrom && !ownsKey(req.user, resumeFrom.key)) {
    return res.status(403).json({ error: "Not your upload" });
  }

  const key = resumeFrom?.key ?? `users/${req.user.id}/${crypto.randomUUID()}/${name}`;
  const uploadId =
    resumeFrom?.uploadId ??
    (await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key }))).UploadId;

  const urls = await Promise.all(
    Array.from({ length: partCount }, (_, i) =>
      getSignedUrl(
        s3,
        new UploadPartCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumber: i + 1 }),
        { expiresIn: 3600 },
      ),
    ),
  );

  res.json({ key, uploadId, urls });
});

app.post("/api/uploads/complete", async (req, res) => {
  const { key, uploadId, parts } = req.body;
  await s3.send(new CompleteMultipartUploadCommand({
    Bucket: BUCKET, Key: key, UploadId: uploadId,
    MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.eTag })) },
  }));
  res.json({ ok: true });
});

app.post("/api/uploads/abort", async (req, res) => {
  const { key, uploadId } = req.body;
  await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId }));
  res.json({ ok: true });
});
```

### Python

```python
import uuid
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
import boto3

s3 = boto3.client("s3", region_name="us-east-1")
BUCKET = "my-bucket"
router = APIRouter()


class ResumeFrom(BaseModel):
    key: str
    uploadId: str


class OpenRequest(BaseModel):
    name: str
    size: int
    partCount: int
    resumeFrom: ResumeFrom | None = None


@router.post("/api/uploads")
def open_upload(body: OpenRequest, user=Depends(current_user)):
    assert_quota(user, body.size)

    if body.resumeFrom:
        # Arrives from the client, so it must be checked before it is trusted.
        if not owns_key(user, body.resumeFrom.key):
            raise HTTPException(403, "Not your upload")
        key, upload_id = body.resumeFrom.key, body.resumeFrom.uploadId
    else:
        key = f"users/{user.id}/{uuid.uuid4()}/{body.name}"
        upload_id = s3.create_multipart_upload(Bucket=BUCKET, Key=key)["UploadId"]

    urls = [
        s3.generate_presigned_url(
            "upload_part",
            Params={"Bucket": BUCKET, "Key": key, "UploadId": upload_id, "PartNumber": n},
            ExpiresIn=3600,
        )
        # Part numbers start at 1, and there must be exactly partCount of them.
        for n in range(1, body.partCount + 1)
    ]
    return {"key": key, "uploadId": upload_id, "urls": urls}


class Part(BaseModel):
    partNumber: int
    eTag: str


class CompleteRequest(BaseModel):
    key: str
    uploadId: str
    parts: list[Part]


@router.post("/api/uploads/complete")
def complete_upload(body: CompleteRequest, user=Depends(current_user)):
    if not owns_key(user, body.key):
        raise HTTPException(403, "Not your upload")
    s3.complete_multipart_upload(
        Bucket=BUCKET, Key=body.key, UploadId=body.uploadId,
        MultipartUpload={
            "Parts": [{"PartNumber": p.partNumber, "ETag": p.eTag} for p in body.parts]
        },
    )
    return {"ok": True}


@router.post("/api/uploads/abort")
def abort_upload(body: CompleteRequest, user=Depends(current_user)):
    if not owns_key(user, body.key):
        raise HTTPException(403, "Not your upload")
    s3.abort_multipart_upload(Bucket=BUCKET, Key=body.key, UploadId=body.uploadId)
    return {"ok": True}
```

Any S3-compatible provider works — R2, MinIO, B2, Wasabi, Ceph. The library
never imports a storage SDK; yours does.

---

## What you get back

`start()`, `resume()`, `pause()` and `cancel()` all resolve to a snapshot, and
`subscribe()` hands you the same shape whenever it changes.

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

Snapshot identity changes only when something actually changed, so binding one
straight to a render is cheap.

**Batch status is derived by precedence, never uniformity.** Anything still
moving makes the batch `uploading`. Once settled: **failed → paused → cancelled
→ succeeded**. A batch holding one paused and one cancelled upload reports
`paused`, because there is still work a person can pick up.

### States, not moments

Rendering "upload failed" from a snapshot is right; firing a toast from one is
not — you would fire it again on every later render. Moments are events:

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

---

## Cancel, pause and resume

Three verbs. The difference is between discarding work and deferring it.

| Verb | Stops in flight | Tears down at provider | Can continue later |
| --- | --- | --- | --- |
| **Pause** | Yes | No | Yes |
| **Cancel** | Yes | Yes | **No — terminal** |
| **Resume** | — | — | Continues from what is missing |

```ts
await batch.pause();            // whole batch
await batch.pause("upload-1");  // one upload, siblings keep going
await batch.cancel();
await batch.resume();
```

Cancel is **terminal**; resuming a cancelled upload is refused with
`NOT_RESUMABLE`. An upload that already succeeded is never torn down.

**Resume** re-opens for fresh URLs, skips parts that already landed (keeping
their ETags), and resets attempt counts so unfinished parts get a full retry
budget. It is a harmless no-op on a succeeded upload.

```ts
const stuck = batch.getSnapshot().uploads.filter((u) => u.resumable);
if (stuck.length > 0) showRetryBanner({ onRetry: () => batch.resume() });
```

Uploads succeed and fail independently — one file exhausting its retries leaves
its siblings running.

---

## Retry and backoff

Retry is **automatic** and happens inside a single part's budget. It is not the
same thing as resume, which a person triggers.

| Failure | Verdict | Why |
| --- | --- | --- |
| Connection failure | Retry | The request never reached anything |
| Timeout | Retry | Same, detected by the clock |
| `429` | Retry | Throttling is temporary by definition |
| `5xx` | Retry | The provider's problem, usually brief |
| `403` / `401` | Re-open once | Almost always an expired presigned URL |
| Other `4xx` | Fatal | Retrying a malformed request wastes time |
| Missing ETag | Fatal | A CORS misconfiguration; repetition cannot fix it |

Fatal failures fail **immediately**, without the backoff ladder.

**The 403 case.** Treated as an expired URL rather than a permission problem,
because expiry is far more common mid-upload. The library re-opens for fresh
URLs and tries again. A second 403 with nothing landing in between is fatal —
that is a real authorisation failure. If parts *did* land in between, the latch
resets, so a multi-hour transfer can outlive one-hour URLs repeatedly.

**Backoff** is exponential with **full jitter** — random across the whole window
rather than a fixed base plus a random addition:

```
delay = random() * min(retryMaxMs, retryBaseMs * 2 ** attempt)
```

When a connection drops, every part in flight fails at the same instant. With a
fixed base they would all wait the same time and retry in lockstep, dropping the
connection again. With the defaults the windows are 0–500 ms, 0–1000 ms, 0–2000 ms.

The budget is **per part**, not shared.

**Going offline** is handled separately: the library parks, waits for the
`online` event, and carries on. Parked time costs no attempts, so a laptop
asleep for an hour does not wake with its budget spent. Set
`waitWhileOffline: false` to fail fast instead.

**Replacing the rule:**

```ts
import { defaultClassifier } from "presigned-multipart-upload";

createBatch({
  files, transport,
  classify: (error, ctx) =>
    (error as { status?: number }).status === 409 ? "retry" : defaultClassifier(error, ctx),
});
```

Return `"retry"`, `"reopen"` or `"fatal"`.

---

## Durable resume

An upload can survive the page it started on. This needs **two** things to
survive, and they are different problems:

1. **The record** — which object, which upload id, which parts landed. The
   library can always keep this.
2. **The bytes** — a `File` cannot be serialised, so persisting the record alone
   gives you a perfect description of an upload you cannot continue.

```ts
import { createBatch, createIndexedDbStore } from "presigned-multipart-upload";

const store = createIndexedDbStore();
const batch = createBatch({ files, transport, store });
```

IndexedDB, not localStorage — it is the only web storage that can hold a file
handle.

### The two recovery paths

**With a file handle** (Chrome, Edge — File System Access API):

```ts
const [handle] = await window.showOpenFilePicker();
const file = await handle.getFile();

createBatch({ files: [{ file, handle }], transport, store });
```

**By re-selecting** — Safari and Firefox, drag-and-drop, or a refused permission
prompt. The user picks the file again and the library verifies it first.

### Finding and continuing

```ts
import { listResumable, createResumedBatch } from "presigned-multipart-upload";

const interrupted = await listResumable({ store });
// each: { id, file, landedParts, totalParts, recovery: "handle" | "reselect" }
```

`recovery` tells you which UI to show — you never test browser support yourself.

Pick up everything recoverable without involving the user:

```ts
const batch = await createResumedBatch({ store, transport, resume: "all" });
await batch.resume();
```

Or handle re-selection explicitly:

```ts
const specs = await Promise.all(
  interrupted.map(async (upload) => ({
    id: upload.id,
    file: upload.recovery === "reselect" ? await askUserFor(upload.file) : undefined,
  })),
);

const batch = await createResumedBatch({ store, transport, resume: specs });
await batch.resume();
```

### The fingerprint

Before a single byte is sent, the offered file is checked against the record on
**name, size and last-modified**. A mismatch refuses with `FINGERPRINT_MISMATCH`
and sends nothing — parts of two different files must never be spliced into one
object. Metadata only, deliberately: hashing a multi-gigabyte file on every
resume would cost more than it protects.

```ts
createResumedBatch({ store, transport, resume: specs, fingerprint: { name: false } });
```

### Records

Records expire after seven days and are cleaned up by `listResumable`. **Both
calls take `recordTtlMs` separately** — pass it to each:

```ts
const TTL = 3 * 24 * 60 * 60 * 1000;
createBatch({ files, transport, store, recordTtlMs: TTL });
listResumable({ store, recordTtlMs: TTL });
```

They are removed as soon as an upload succeeds or is cancelled.

**On shared devices**, scope them:

```ts
import { scopeStore, createIndexedDbStore } from "presigned-multipart-upload";
const store = scopeStore(createIndexedDbStore(), user.id);
```

---

## Very large files

Nothing here changes the API, but four things scale with the file and it is
worth knowing which.

### Part size is chosen for you

S3 and every compatible provider cap an upload at **10,000 parts**. That makes a
fixed part size a ceiling on file size: at 10 MiB per part you cannot exceed
~97 GiB, and a 300 GiB file would be refused outright.

So `partSize` is derived per file when you do not set it — 10 MiB, or the
smallest whole MiB that fits the file inside the part limit, whichever is
larger:

| File | Chosen part size | Parts |
| --- | --- | --- |
| 40 MiB | 10 MiB | 4 |
| 8 GiB | 10 MiB | 820 |
| 300 GiB | 31 MiB | 9,910 |
| 2 TiB | 210 MiB | 9,987 |

Set `partSize` yourself only to override that, and note what it costs below.
Anything the provider cannot accept is rejected before your `open` is called, so
a file that will never upload never leaves a dangling multipart upload behind.

### Memory is `partSize` × `concurrency`

Parts are read from the file lazily, so the file itself is never in memory. The
**parts in flight** are. With the default `concurrency` of 5, a 300 GiB file at
31 MiB parts holds roughly **155 MiB** — fine on a desktop, tight on an old
phone.

That is the tradeoff to weigh if you are tempted to raise `partSize` for
throughput. Lower `concurrency` in the same breath:

```ts
createBatch({ files, transport, partSize: 128 * 1024 * 1024, concurrency: 2 });
```

### Sign parts on demand, not all at once

This is the cost most people miss. By default `open` must return `partCount`
URLs, and for a 300 GiB file that is ~9,900 of them — several megabytes of JSON,
and several thousand signatures computed per request. Signing is local and cheap
(no call to AWS), but it is not free, and **it happens again on every refresh**.

Give the Transport a fourth function and the library signs only what it is about
to send:

```ts
const transport = httpTransport({
  baseUrl: "/api/uploads",
  paths: { sign: "/sign" },
});
```

`open` then returns just `{ key, uploadId }`, and `POST /api/uploads/sign`
receives `{ key, uploadId, partNumbers }` and returns `{ urls: { 41: "…", … } }`.
The library keeps a window of `urlWindow` parts signed ahead (default: four times
`concurrency`), and an expired URL costs a re-signing of the parts in flight
rather than a re-opening of all 9,900. See
[the backend contract](/guide/backend-contract#signing-parts-on-demand).

Under a few hundred parts it is not worth the endpoint. Past a thousand, it is.
Raising `partSize` is the other lever, and they compose: 128 MiB parts turn
9,910 URLs into 2,400.

### It will outlive its URLs

300 GiB at 100 Mbps is around seven hours; presigned URLs typically last one. The
library handles this — a 403 on a part triggers a **refresh** for fresh URLs and
the run continues from where it was. Parts in flight share their URLs' expiry, so
five parts meeting it at once cost one refresh between them, not five. Where you
supply `signParts` the refresh re-signs those parts; where you do not, it re-opens.
Two things on your side make it work:

- Return **fresh URLs** every time, including when `resumeFrom` is present.
  Replaying a stale list is the one way to break this.
- Set your bucket's lifecycle rule generously enough that a legitimate long
  upload is not swept away mid-flight. See [bucket setup](#bucket-setup).

### What the store actually holds

A common worry, and the answer is reassuring: **the record does not scale with
the bytes.** It holds the key, the upload id, the part size, and one
`{ partNumber, eTag }` pair per landed part — around 60 bytes each. A 300 GiB
file in ~9,900 parts is roughly **600 KB**, against an IndexedDB quota measured
in gigabytes.

The file's bytes are never copied into IndexedDB. What is stored is a *file
handle* — a reference the browser resolves back to the file on disk.

One consequence worth knowing: a record is rewritten whole. Above 200 parts,
writes are coalesced to at most one every two seconds rather than one per landed
part. If the tab dies inside that window, the parts that landed in it are
re-sent on resume — a few seconds of work, not a few hours.

---

## Frameworks

All optional peers — importing the core pulls in no framework, and the core
works perfectly on its own.

### React

```tsx
import { useUpload } from "presigned-multipart-upload/react";

const Uploader = ({ files }: { files: File[] }) => {
  // Pass options and the hook owns the batch — no useMemo to forget.
  const { snapshot, file, start, pause, resume, cancel } = useUpload({
    files,
    transport: httpTransport({ baseUrl: "/api/uploads" }),
  });

  return (
    <>
      <progress value={snapshot.progress.percent} max={100} />
      {snapshot.status === "idle" && <button onClick={start}>Upload</button>}
      {snapshot.status === "uploading" && <button onClick={() => pause()}>Pause</button>}
      {(snapshot.status === "paused" || snapshot.status === "failed") && (
        <button onClick={() => resume()}>Continue</button>
      )}
      <button onClick={() => cancel()}>Cancel</button>
      {file && <span>{file.file.name} — {file.status}</span>}
    </>
  );
};
```

`useUpload(controller)` also accepts an existing controller. For moments rather
than states:

```tsx
import { useUploadEvent } from "presigned-multipart-upload/react";
useUploadEvent(batch, "upload:succeeded", ({ uploadId }) => toast.success(uploadId));
```

### Angular

```ts
import { createAngularUpload } from "presigned-multipart-upload/angular";

@Injectable()
export class UploadService implements OnDestroy {
  private transport = inject(UPLOAD_TRANSPORT);
  private upload = createAngularUpload(createBatch({ files: [], transport: this.transport }));

  readonly snapshot = this.upload.snapshot;   // Signal
  readonly snapshot$ = this.upload.snapshot$; // Observable, same state
  ngOnDestroy() { this.upload.destroy(); }
}
```

Signals work identically in zone-based and zoneless apps; the Observable is a
view onto the same state, not a second source of truth.

### Vue

```vue
<script setup lang="ts">
import { useUpload } from "presigned-multipart-upload/vue";
const { snapshot, start, pause, resume, cancel } = useUpload(batch);
</script>

<template>
  <progress :value="snapshot.progress.percent" max="100" />
</template>
```

`snapshot` is a `shallowRef` — snapshots are replaced whole, so deep reactivity
would walk every part on every tick for nothing.

### Svelte, and anything else

No adapter needed. The core's `subscribe` already satisfies Svelte's readable
store contract:

```svelte
<progress value={$batch.progress.percent} max="100" />
```

The same three-method surface (`subscribe`, `getSnapshot`, `on`) is the
intersection of what every framework's reactivity wants — an adapter for Solid,
Qwik or Lit is about five lines.

---

## Options

Everything has a working default. Only `files` and `transport` are required.

| Option | Default | What it does |
| --- | --- | --- |
| `files` | — | `Array<File \| { file, handle? }>`. The handle enables durable resume. |
| `transport` | — | Your three backend functions. |
| `partSize` | chosen per file | Bytes per part. Left unset it is derived from the file — see [very large files](#very-large-files). |
| `provider` | `"s3"` | `"s3" \| "r2" \| "b2" \| "minio" \| "wasabi" \| { minPartSize, maxParts, maxPartSize, maxObjectSize }` |
| `concurrency` | 5 | Parts in flight across the **whole batch**. |
| `maxRetries` | 3 | Retries *after* the first attempt, per part. |
| `retryBaseMs` | 500 | Backoff window, doubled per attempt. |
| `retryMaxMs` | 15000 | Backoff ceiling. |
| `partTimeoutMs` | 0 | Per-attempt timeout; 0 disables. |
| `waitWhileOffline` | `true` | Park instead of spending retries. |
| `classify` | built-in | Replace the retry rule. |
| `urlWindow` | `concurrency * 4` | Parts signed ahead, when the Transport supplies `signParts`. |
| `contentType` | file's own | Sent with each part. |
| `store` | none | Enables durable resume. |
| `recordTtlMs` | 7 days | How long a record stays resumable. |
| `fingerprint` | all three | Which fields must match on re-selection. |
| `platform` | browser | The single door to the outside world. |

**`concurrency`** deserves a note. Browsers cap simultaneous connections per
host — six in Chrome and Firefox. Exceeding it does not fail loudly: the surplus
queues below the network layer where it reports no progress and can time out
having never been sent. One queue serves the whole batch, so every part the
library believes is in flight really is on the wire.

**`provider`** groups facts about the storage service, as opposed to
preferences. All S3-compatible providers currently share S3's numbers; the
presets exist so the choice is explicit rather than something to look up.

**`platform`** is how everything is made testable — sending bytes, time,
randomness, connectivity, file handles. Nothing in the core reaches past it.

```ts
import { browserPlatform } from "presigned-multipart-upload";
createBatch({ files, transport, platform: { ...browserPlatform(), random: () => 0.5 } });
```

---

## Errors

Errors carry a stable `code`, so you can branch on cause without matching on
message text. Thrown errors are `UploadError` instances.

| Code | Meaning | What to do |
| --- | --- | --- |
| `MISSING_ETAG` | Response carried no readable ETag | Add `ETag` to CORS `ExposeHeaders` |
| `INVALID_PART_SIZE` | `partSize` outside the provider's floor or ceiling | Adjust it, or leave it unset |
| `PART_COUNT_EXCEEDED` | File needs more parts than allowed | Leave `partSize` unset, or raise it |
| `FILE_TOO_LARGE` | Above the provider's single-object limit | Nothing to do — 5 TiB is the ceiling |
| `EMPTY_FILE` | Zero bytes | Use an ordinary single `PUT` |
| `URL_COUNT_MISMATCH` | Transport returned the wrong number of URLs, or opened a second upload on a resume | Fix the backend |
| `URL_MISSING` | `signParts` returned no URL for a part it was asked to sign | Fix the backend |
| `RETRIES_EXHAUSTED` | A part used its whole budget | `resume()` — nothing was discarded |
| `SEND_FAILED` | Fatal by the classifier | Inspect the cause |
| `TRANSPORT_OPEN_FAILED` | Your `open` rejected | Nothing to tear down |
| `TRANSPORT_COMPLETE_FAILED` | Your `complete` rejected | `resume()` retries finalising |
| `NOT_RESUMABLE` | Cancelled, or no such upload/record | Start over |
| `FILE_REQUIRED` | Bytes unrecoverable unaided | Show a file picker |
| `FINGERPRINT_MISMATCH` | Wrong file offered on resume | Offer to start over |

`FILE_REQUIRED` is expected on Safari and Firefox — it is a branch to handle,
not an error to log.

> **`fetch` does not reject on 5xx.** If you hand-write the transport and skip
> `response.ok`, a failing `complete` looks like success: the upload is marked
> succeeded and its resume record deleted, for an object never finalised.
> `httpTransport` handles this for you.

---

## Bucket setup

Two pieces of configuration are required, and both fail confusingly when missing.

### CORS — expose the ETag header

Every part upload returns an `ETag`, and finalising needs all of them. Browsers
hide response headers unless the server lists them.

```json
[{
  "AllowedOrigins": ["https://app.example.com"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3000
}]
```

Without it, parts upload perfectly and finalising then rejects them. The library
detects this specific case and fails immediately with `MISSING_ETAG`.

### Lifecycle rule — clean up abandoned parts

This library **leaves failed uploads open on purpose**; that is what makes resume
possible. The cost is that an upload nobody returns to sits there billing you,
invisible in a normal object listing.

```json
{
  "Rules": [{
    "ID": "abort-incomplete-multipart-uploads",
    "Status": "Enabled",
    "Filter": { "Prefix": "" },
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
  }]
}
```

Match it to your `recordTtlMs`. Check what is already there with
`aws s3api list-multipart-uploads --bucket my-bucket`.

### Limits

| Limit | Value | Enforced? |
| --- | --- | --- |
| Minimum part size | 5 MiB, except the last | Yes — `INVALID_PART_SIZE` |
| Maximum parts | 10,000 | Yes — `PART_COUNT_EXCEEDED` |
| Maximum part size | 5 GiB | Yes — `INVALID_PART_SIZE` |
| Maximum object | 5 TiB | Yes — `FILE_TOO_LARGE` |

All four are checked **before** the transport is asked to open anything, so a
file that cannot be uploaded never leaves a dangling multipart upload behind.
They are the S3 numbers, which every S3-compatible provider meets; pass
`provider` as an object to state different ones.

---

## Glossary

Words used precisely throughout. Where everyday speech blurs two together, the
library does not.

- **Upload** — one file's journey to a stored object.
- **Part** — one contiguous byte range, uploaded independently, numbered from 1.
- **Batch** — the set of uploads driven together. A single file is a batch of one.
- **Presigned URL** — minted by *your* backend, authorising one operation for a
  limited time. This library only consumes them.
- **Transport** — your three functions: open, complete, abort.
- **Opening** — making an upload ready for parts. Serves two occasions, and is
  always told which.
- **Connection Budget** — the ceiling on parts in flight across the whole batch.
- **Attempt** — one transmission of one part's bytes.
- **Retry** — a further attempt, decided by the library. **Automatic.**
- **Resume** — a **user-triggered** restart from whichever parts have not landed.
- **Cancel** — user-triggered, **terminal**. Discards the work.
- **Pause** — user-triggered halt that keeps the upload alive. Defers the work.
- **Durable Resume** — resuming an upload that outlived its page.
- **Upload Record** — the persisted account of what landed.
- **File Handle** — a durable reference to the file on disk.
- **Fingerprint** — the check that offered bytes are the same file.
- **Core / Adapter / Platform** — the engine, its framework bindings, and its
  single door to the outside world.

---

## Development

```bash
npm test                   # 156 tests, no network, no container
npm run typecheck
npm run build
npm run test:integration   # needs MinIO; npm run minio:up
npm run docs:dev           # the same documentation as a browsable site
```

## Licence

MIT
