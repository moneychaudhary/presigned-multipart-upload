# Retry and backoff

A part that fails for a transient reason is retried by the library, invisibly.
You do not need to do anything to get this, and it is not the same thing as
[resume](/guide/lifecycle#resume) — retry is automatic and happens inside a
single part's budget; resume is something a person triggers.

## What is retried

| Failure | Verdict | Why |
| --- | --- | --- |
| Connection failure | Retry | The request never reached anything |
| Timeout | Retry | Same situation, detected by the clock |
| `429` | Retry | Throttling is temporary by definition |
| `5xx` | Retry | The provider's problem, usually brief |
| `403` / `401` | Re-open once | Almost always an expired presigned URL |
| Other `4xx` | Fatal | Retrying a malformed request just wastes time |
| Missing ETag | Fatal | A CORS misconfiguration; repetition cannot fix it |

Fatal failures fail **immediately**, without working through the ladder. A
malformed key should report in milliseconds, not after four backoff waits.

## The 403 case

A `403` mid-upload is treated as an expired URL rather than a permission
problem, because expiry is overwhelmingly the more common cause. The library
re-opens the upload for fresh URLs and tries again.

If the retry `403`s again with nothing having landed in between, it is fatal —
that is a real authorisation failure, not expiry.

If parts *did* land in between, the latch resets. A long upload can outlive its
URLs several times and recover each time, which matters when a multi-hour
transfer meets one-hour URLs.

## Backoff

Delays grow exponentially with **full jitter** — a random value across the whole
window, rather than a fixed base plus a random addition:

```
delay = random() * min(retryMaxMs, retryBaseMs * 2 ** attempt)
```

Full jitter matters more than it looks. When a connection drops, every part in
flight fails at the same instant. With a fixed base they would all wait the same
time and retry in lockstep, dropping the connection again. Spreading them across
the whole window breaks the synchronisation.

With the defaults, the windows are 0–500 ms, 0–1000 ms, 0–2000 ms.

## Tuning

```ts
createBatch({
  files,
  transport,
  maxRetries: 3,        // retries after the first attempt, per part
  retryBaseMs: 500,
  retryMaxMs: 15_000,
  partTimeoutMs: 0,     // 0 disables; set it if hung connections are a problem
});
```

The budget is **per part**, not shared. Five parts each failing once is normal
and succeeds; one part failing four times exhausts only that part's budget —
and that is what fails the upload.

## Watching it happen

```ts
batch.on("part:retrying", ({ uploadId, partNumber, attempt, delayMs }) => {
  console.log(`part ${partNumber} attempt ${attempt}, waiting ${delayMs}ms`);
});
```

Attempt counts are also on every snapshot, at `upload.parts[i].attempts`.

## Going offline

Losing connectivity is handled separately from retrying, and deliberately so.
When the browser reports itself offline the library **parks**: it stops, waits
for the `online` event, and carries on. Parked time costs no attempts.

Without this, a laptop asleep for an hour would burn through every part's retry
budget while disconnected and wake up with nothing left.

```ts
createBatch({ files, transport, waitWhileOffline: false }); // fail fast instead
```

## Replacing the rule

Some S3-compatible providers return statuses the default rule does not expect.
Replace it:

```ts
import { defaultClassifier } from "presigned-multipart-upload";

createBatch({
  files,
  transport,
  classify: (error, ctx) => {
    if ((error as { status?: number }).status === 409) return "retry";
    return defaultClassifier(error, ctx);
  },
});
```

Return `"retry"`, `"reopen"` or `"fatal"`. `ctx.alreadyReopened` tells you
whether this upload has already re-opened since its last successful part, which
is how you avoid an infinite re-open loop.

## When retries run out

The upload moves to `failed` and **stays resumable**. It is not torn down, the
landed parts keep their ETags, and `resume()` picks up from what is missing.

See [cancel, pause and resume](/guide/lifecycle).
