# Cancel, pause and resume

Three verbs, and the difference between them is the difference between
discarding work and deferring it. Getting them confused is how people lose four
gigabytes.

| Verb | Stops in flight | Tears down at provider | Can continue later |
| --- | --- | --- | --- |
| **Pause** | Yes | No | Yes |
| **Cancel** | Yes | Yes | **No — terminal** |
| **Resume** | — | — | Continues from what is missing |

## Pause

A decision to defer. Scheduling stops, requests in flight are aborted, and the
multipart upload stays open at the provider.

```ts
await batch.pause();            // the whole batch
await batch.pause(id);          // one upload, siblings keep going
```

Upload ids come off the snapshot — `snapshot.uploads[n].id` — and are minted per
Upload rather than being positional, so they stay unique across batches, tabs and
later page sessions. Never construct one:

```ts
const { id } = batch.getSnapshot().uploads[0];
```

Pausing is immediate rather than "immediate once the current 10 MiB finishes",
because individual requests are abortable.

## Cancel

A decision to discard. Everything pause does, plus `abort` on your Transport so
the provider stops charging for orphaned parts.

```ts
await batch.cancel();
await batch.cancel(id);
```

Cancel is **terminal**. Resuming a cancelled upload is refused with
`NOT_RESUMABLE` — there is nothing left to resume.

An upload that already succeeded is never torn down; the object exists, and
aborting it would be wrong. Cancelling something that never started marks it
cancelled without troubling your backend at all.

## Resume

Continues an upload that is paused or failed, from the parts that never landed.

```ts
await batch.resume();
await batch.resume(id);
```

Resume:

- **re-opens** the upload, so it works with fresh presigned URLs rather than
  stale ones
- **skips** parts that already landed, keeping their ETags for finalising
- **resets attempt counts** on unfinished parts, so they get a full retry budget
  rather than inheriting an exhausted one

Resume on a succeeded upload is a harmless no-op, so a double-click cannot break
anything.

## After a failure

This is the case the library exists for. When retries run out:

```ts
const settled = await batch.start();

if (settled.status === "failed") {
  // Nothing was thrown away.
  await batch.resume();
}
```

The upload was **not** torn down. Everything that landed is still on the
provider. A resume sends only what is missing.

Whether an upload can be continued is on the snapshot:

```ts
snapshot.uploads.filter((upload) => upload.resumable);
```

::: warning The trade-off
Leaving failed uploads open is what makes this work, and it means abandoned
uploads accumulate at your provider. Set a lifecycle rule — see
[bucket setup](/guide/bucket-setup#lifecycle-rule).
:::

## Failing one file does not fail the rest

Uploads in a batch succeed and fail independently. One file exhausting its
retries leaves its siblings running, and the batch reports `failed` only because
something in it failed — the successful uploads are still finished and finalised.

Batch status is derived by precedence, never by uniformity. Anything still
moving makes the batch `uploading`. Once everything has settled the order is
**failed → paused → cancelled → succeeded**: the most actionable state wins, so
a batch holding one paused and one cancelled upload reports `paused`, because
there is still work a person can pick up. Only when nothing failed, nothing is
paused and nothing was cancelled does a batch claim `succeeded`.

## A retry button

Putting it together:

```ts
const snapshot = batch.getSnapshot();
const stuck = snapshot.uploads.filter((upload) => upload.resumable);

if (stuck.length > 0) {
  showBanner(`${stuck.length} upload(s) interrupted`, {
    onRetry: () => batch.resume(),
    onDiscard: () => batch.cancel(),
  });
}
```

To make that button survive a page reload as well, see
[durable resume](/guide/durable-resume).
