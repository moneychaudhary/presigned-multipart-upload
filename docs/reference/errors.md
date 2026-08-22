# Errors

Errors carry a stable `code`, so you can branch on cause without matching on
message text.

```ts
snapshot.uploads[0].error; // { code, message } | null
```

Thrown errors are `UploadError` instances with the same `code`.

```ts
import { UploadError } from "presigned-multipart-upload";

try {
  await batch.resume("upload-1");
} catch (error) {
  if (error instanceof UploadError && error.code === "NOT_RESUMABLE") {
    // …
  }
}
```

## Setup problems

### `MISSING_ETAG`

A part uploaded successfully but the response carried no readable `ETag`.

Almost always CORS: the bucket does not list `ETag` under `ExposeHeaders`, so
the browser hides it. Fatal immediately rather than retried, because repetition
cannot fix a configuration problem.

**Fix:** [bucket setup](/guide/bucket-setup#cors-expose-the-etag-header).

### `INVALID_PART_SIZE`

`partSize` is below `minPartSize`. Caught before anything is sent.

### `PART_COUNT_EXCEEDED`

The file needs more parts than the provider allows. **Fix:** raise `partSize`.

### `EMPTY_FILE`

A zero-byte file cannot be uploaded as multipart. Handle these with an ordinary
single `PUT`.

### `URL_COUNT_MISMATCH`

The transport returned a number of URLs that does not equal the part count.

Too few and parts have nowhere to go; too many usually means a stale list from
an earlier opening, which would misalign every part. Both are rejected before
any byte is sent.

## Failures in flight

### `RETRIES_EXHAUSTED`

A part used its whole retry budget.

The upload is **not** torn down — it is left open and `resumable`, which is the
entire point. Call `resume()` to pick up from the parts that never landed.

### `SEND_FAILED`

A part failed for a reason the classifier judged fatal — typically a `4xx` other
than 401/403, or a second 403 after re-opening.

### `TRANSPORT_OPEN_FAILED`

Your `open` rejected. The upload never started; nothing to tear down.

### `TRANSPORT_COMPLETE_FAILED`

Your `complete` rejected. Every part landed but the object was not finalised.

The upload stays open and **remains resumable** even though nothing is left to
send — a resume re-opens and calls `complete` again. This is why `resumable`
does not simply mean "some part is missing": an upload stranded at the last step
still has work to do.

::: warning `fetch` does not reject on 5xx
If your `complete` uses `fetch` without checking `response.ok`, a failing
endpoint resolves successfully. The upload is then marked succeeded and its
resume record deleted, for an object that was never finalised. See the
[complete client example](/guide/getting-started#a-complete-client).
:::

## Lifecycle

### `CANCELLED` / `PAUSED`

Internal signals rather than failures. They move the upload to `cancelled` or
`paused` and are not surfaced as errors on the snapshot — a paused upload has
`error: null`.

### `NOT_RESUMABLE`

Thrown by `resume(id)` for an upload that cannot continue: it was cancelled
(terminal by design), or the id does not exist.

Also thrown by `createResumedBatch` when no record exists for the id.

## Durable resume

### `FILE_REQUIRED`

The bytes could not be recovered on their own — this browser has no file handle
support, none was stored, or the permission prompt was refused.

**Fix:** show a file picker and pass the result as `file` in the resume spec.
This is expected on Safari and Firefox, not an error condition to log.

### `FINGERPRINT_MISMATCH`

The re-selected file is not the one the record describes. The message names
which field differed.

Nothing is sent. **Fix:** tell the user they picked a different file and offer
to start over — or relax the check with the `fingerprint` option if your flow
legitimately renames files.

## Handling them together

```ts
const messageFor = (code) => {
  switch (code) {
    case "RETRIES_EXHAUSTED":
      return "Upload interrupted. Retry to continue where it stopped.";
    case "FINGERPRINT_MISMATCH":
      return "That is a different file. Choose the original, or start over.";
    case "FILE_REQUIRED":
      return "Choose the file again to continue.";
    case "MISSING_ETAG":
    case "URL_COUNT_MISMATCH":
      return "Upload is misconfigured. Contact support.";
    default:
      return "Upload failed.";
  }
};
```
