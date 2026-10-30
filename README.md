# presigned-multipart-upload

[![npm](https://img.shields.io/npm/v/presigned-multipart-upload)](https://www.npmjs.com/package/presigned-multipart-upload)
[![CI](https://github.com/moneychaudhary/presigned-multipart-upload/actions/workflows/ci.yml/badge.svg)](https://github.com/moneychaudhary/presigned-multipart-upload/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/presigned-multipart-upload)](https://www.npmjs.com/package/presigned-multipart-upload)
[![license](https://img.shields.io/npm/l/presigned-multipart-upload)](./LICENSE)

Upload files of any size from React or Angular straight to S3, through presigned
URLs. Parts upload in parallel and retry on their own; uploads pause, resume —
even after a page reload — and cancel. Your server mints the URLs, with a
handler this package provides.

- **No credentials in the browser.** It only PUTs to URLs your server signed.
- **Survives reloads.** What landed is remembered; only the rest is sent.
- **Speed and time left**, not just a percentage.
- **Small files in one request**, large ones in parts up to S3's 5 TiB.
- **Optional checksums**, so S3 refuses a corrupted part.
- **No runtime dependencies** in the browser.

<img src="https://raw.githubusercontent.com/moneychaudhary/presigned-multipart-upload/main/playground/screenshots/react-uploading.png" alt="A batch of three files mid-upload, with overall progress, speed, time left, a per-part progress strip for each file and a live activity feed" width="900">

<sub>From the [playground](https://github.com/moneychaudhary/presigned-multipart-upload/tree/main/playground): React, mid-upload to S3. Every screenshot here is a real upload, taken by its end-to-end tests.</sub>

```bash
npm install presigned-multipart-upload
# on the server
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

## Quick start

### 1. The server

One handler serves every endpoint the browser calls. It runs anywhere with
`Request` and `Response` — Next.js, Remix, Hono, Bun, Deno:

```ts
// app/api/uploads/[[...path]]/route.ts
import { S3Client } from "@aws-sdk/client-s3";
import { createUploadHandler } from "presigned-multipart-upload/server";

const s3 = new S3Client({
  region: "us-east-1",
  // Required: otherwise recent SDKs sign an empty body's checksum into every
  // upload URL, and S3 refuses every part. The handler checks for it.
  requestChecksumCalculation: "WHEN_REQUIRED",
});

export const POST = createUploadHandler({
  s3,
  bucket: "my-uploads",
  key: (file) => `users/${currentUserId()}/${crypto.randomUUID()}/${file.name}`,
  authorize: (_request, key) => key.startsWith(`users/${currentUserId()}/`),
});
```

With Express or Node's own server, wrap it — and mount it before any JSON body
parser:

```ts
import { toNodeHandler } from "presigned-multipart-upload/server";

app.post("/api/uploads{/*path}", toNodeHandler(createUploadHandler({ s3, bucket: "my-uploads" })));
```

### 2. The bucket

```json
[
  {
    "AllowedOrigins": ["https://your-app.example"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"]
  }
]
```

That is the bucket's CORS configuration; without `ETag` exposed, every part
fails with `MISSING_ETAG`. Also add a **lifecycle rule that aborts incomplete
multipart uploads after 7 days**. A failed upload is left open so it can be
resumed; the rule cleans up the ones nobody comes back for, whose parts are
billed until it does.

### 3. The browser, in React

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

The uploader is rebuilt only when the file list changes, so keep files in state.
Pass a built uploader instead of options to share one between components, and
use `useUploaderEvent(uploader, "upload:succeeded", handler)` for events.

<img src="https://raw.githubusercontent.com/moneychaudhary/presigned-multipart-upload/main/playground/screenshots/react-done.png" alt="React demo: a finished batch of a multipart audio file and two small files sent as single PUTs" width="720">

Full example: [`playground/src/react`](https://github.com/moneychaudhary/presigned-multipart-upload/tree/main/playground/src/react).

### 3. Or in Angular

```ts
import { httpTransport } from "presigned-multipart-upload";
import { createAngularUploader } from "presigned-multipart-upload/angular";

@Injectable()
export class UploadService implements OnDestroy {
  private upload = createAngularUploader({
    files,
    transport: httpTransport({ baseUrl: "/api/uploads" }),
  });
  snapshot = this.upload.snapshot; // Signal
  snapshot$ = this.upload.snapshot$; // Observable

  start = () => this.upload.start();
  ngOnDestroy() {
    this.upload.dispose();
  }
}
```

Signals work zoned and zoneless; `snapshot$` is the same state for RxJS code.

<img src="https://raw.githubusercontent.com/moneychaudhary/presigned-multipart-upload/main/playground/screenshots/angular-paused.png" alt="Angular demo: a large file paused part-way with three of eight parts stored, beside a small file that finished as a single PUT" width="720">

Full example: [`playground/src/angular`](https://github.com/moneychaudhary/presigned-multipart-upload/tree/main/playground/src/angular).

## What you get

### Progress

```ts
snapshot.status; // idle | uploading | paused | succeeded | failed | cancelled
snapshot.progress.percent; // 0–100, never goes backwards
snapshot.progress.bytesPerSecond; // recent speed, or null when nothing is moving
snapshot.progress.remainingMs; // time left, or null
snapshot.upload; // the sole upload, when there is exactly one
snapshot.uploads; // each file: status, progress, parts, error, key
```

Statuses, events and error codes are exported as constants
(`UploaderStatus.Succeeded`, `UploadEvent.UploadFailed`,
`UploadErrorCode.MissingETag`), so a typo is a compile error.

### Pause, resume, cancel

`pause()`, `resume()` and `cancel()` act on every file, or on one by its `id`
from the snapshot. All three take effect at once, mid-part. Pause keeps the
upload; cancel discards it and tears it down in S3. `start()` never throws — a
failure lands on that file's snapshot, and `resume()` tries it again.

### Retries

Network errors, timeouts, `429` and `5xx` are retried with backoff — from S3
and from your server alike. An expired URL (`403`) is re-signed once, for every
part that hit it together. While the browser is offline, everything waits
rather than fails. Files take turns at the connections, so a small file is not
stuck behind a large one.

<img src="https://raw.githubusercontent.com/moneychaudhary/presigned-multipart-upload/main/playground/screenshots/angular-flaky-network.png" alt="Angular demo: a file finished on a flaky network, with retried parts shown in the activity feed" width="720">

### Resume after a reload

What landed is kept in IndexedDB. After a reload, list what was interrupted and
hand each file back:

```ts
const interrupted = await listResumable();
// [{ id, file, partCount, landedPartCount, recovery: "handle" | "reselect" }]

const uploader = await resumeUploader({
  transport: httpTransport({ baseUrl: "/api/uploads" }),
  resume: await Promise.all(
    interrupted.map(async (u) => ({
      id: u.id,
      file: u.recovery === "reselect" ? await askUserToPickAgain(u.file) : undefined,
    })),
  ),
});
await uploader.resume(); // or pass it to useUploader / createAngularUploader
```

A re-selected file is checked by name, size and modified time before anything
is sent. In Chrome, pass `{ file, handle }` from `showOpenFilePicker()` and the
file comes back without asking. Records expire after 7 days.

<img src="https://raw.githubusercontent.com/moneychaudhary/presigned-multipart-upload/main/playground/screenshots/resume-after-reload.png" alt="After a reload, a card lists an interrupted upload with four of eleven parts stored and a button to re-select the file and resume" width="720">

### Checksums

Add `checksum: "CRC32"` to the uploader's options and S3 verifies every part
against a checksum computed from the file: a part corrupted on the way is
refused, not stored. The server handler signs them in; nothing else changes.

## Options

**Uploader** — `useUploader`, `createAngularUploader`, `createUploader`:

| Option        | Default   |                                                                 |
| ------------- | --------- | --------------------------------------------------------------- |
| `files`       | —         | `File[]`, or `{ file, handle }[]` to resume without a picker    |
| `transport`   | —         | `httpTransport({ baseUrl })` — where your server handler is     |
| `concurrency` | `5`       | Parts in flight, across all files                               |
| `partSize`    | per file  | 10 MiB, or larger when a file needs it to fit S3's 10,000 parts |
| `retry`       | see right | `{ max: 3, baseMs: 500, maxMs: 15000, timeoutMs: 0 }`           |
| `checksum`    | off       | `"CRC32"` to have S3 verify every part                          |
| `store`       | IndexedDB | Where resume records live; `null` for none                      |

Rarely needed: `waitWhileOffline` (default `true`), `classify`, `urlWindow`,
`limits`, `fingerprint`, `recordTtlMs`, `platform`.

**Server** — `createUploadHandler`:

| Option         | Default                 |                                                        |
| -------------- | ----------------------- | ------------------------------------------------------ |
| `s3`, `bucket` | —                       | Your client and bucket                                 |
| `key`          | `uploads/<uuid>/<name>` | The object key for a new upload                        |
| `authorize`    | allow                   | `(request, key) => boolean`, before touching an upload |
| `maxSize`      | 5 TiB                   | Larger files are refused with `413`                    |
| `allowedTypes` | any                     | e.g. `["image/*", "application/pdf"]`                  |
| `expiresIn`    | `3600`                  | Seconds each presigned URL lasts                       |

Set `authorize` whenever keys are not unguessable per user: resuming, signing,
finishing and aborting all name an upload the browser chose.

## Errors

`error.code` is stable; branch on it, not the message.

| Code                                                                       | Means                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `MISSING_ETAG`                                                             | **Expose `ETag` in the bucket's CORS**                        |
| `RETRIES_EXHAUSTED`                                                        | A part used every retry — offer `resume()`                    |
| `SEND_FAILED`                                                              | S3 refused a part, or the browser is offline with waiting off |
| `TRANSPORT_OPEN_FAILED`                                                    | Your server could not start the upload                        |
| `TRANSPORT_SIGN_FAILED`                                                    | Your server could not sign parts                              |
| `TRANSPORT_COMPLETE_FAILED`                                                | Your server could not finish the upload                       |
| `FILE_REQUIRED`                                                            | Resuming needs the file — ask the user to pick it             |
| `FINGERPRINT_MISMATCH`                                                     | The re-selected file is a different one                       |
| `NOT_RESUMABLE`                                                            | Nothing to resume                                             |
| `INVALID_OPTIONS`                                                          | An option was the wrong shape                                 |
| `EMPTY_FILE`, `FILE_TOO_LARGE`, `INVALID_PART_SIZE`, `PART_COUNT_EXCEEDED` | The file or part size is outside S3's limits                  |
| `URL_COUNT_MISMATCH`, `URL_MISSING`, `RESUME_MISMATCH`                     | A custom server broke the contract below                      |
| `UNKNOWN`                                                                  | Nothing recognised the failure — worth reporting              |

## Advanced

**Your own server.** `httpTransport` POSTs JSON to five paths under `baseUrl`:

| Path        | Receives                                                           | Returns                  |
| ----------- | ------------------------------------------------------------------ | ------------------------ |
| `/`         | `{ name, size, type, resumeFrom?, checksumAlgorithm? }`            | `{ key, uploadId }`      |
| `/sign`     | `{ key, uploadId, partNumbers, checksumsCRC32? }`                  | `{ urls: { [n]: url } }` |
| `/single`   | `{ name, size, type, checksumCRC32? }`                             | `{ key, url }`           |
| `/complete` | `{ key, uploadId, parts: [{ partNumber, eTag, checksumCRC32? }] }` | any 2xx                  |
| `/abort`    | `{ key, uploadId }`                                                | any 2xx                  |

On `resumeFrom`, return that same upload. A server that cannot sign on demand
may return every URL from `/` as `urls` instead, with `paths: { sign: null }`.
Not JSON, or not HTTP? Implement `Transport` yourself; its types are exported.

**Extension points** live in `presigned-multipart-upload/advanced`: a custom
`Platform` (how parts are sent, timers, the clock), the retry `classify`
function and the failure shapes it reads, and the record stores.
`scopeStore(createIndexedDbStore(), userId)` keeps one person's resumable
uploads out of the next person's reach on a shared machine.

## Words used here

- **Upload** — one file, from selection to stored object. **Part** — one byte
  range of it, sent on its own.
- **Batch** — the files one uploader drives together; a single file is a batch
  of one.
- **Retry** — the library trying a part again, by itself. **Resume** —
  continuing an unfinished upload, when you ask. **Pause** keeps the work;
  **Cancel** discards it.
- **Upload record** — what is kept across reloads: which parts landed, never
  the file's bytes.

## Support

Browsers from 2022 on (ES2022: Chrome 94, Safari 16.4, Firefox 93). The server
handler needs Node 20+ or any runtime with `fetch`. S3 only.

## Playground and development

[`playground/`](https://github.com/moneychaudhary/presigned-multipart-upload/tree/main/playground)
runs everything above against S3 on LocalStack, with Playwright tests through
each framework: `cd playground && npm install && npm run aws:up && npm run dev`.
In this repository, `npm test`, `npm run lint` and `npm run typecheck`; a
pre-commit hook runs them.

MIT.
