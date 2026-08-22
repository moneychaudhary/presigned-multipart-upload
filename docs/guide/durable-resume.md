# Durable resume

An upload can survive the page it started on. Someone can close the tab at 90%
of a four-gigabyte file, come back tomorrow, and finish it.

This needs **two** things to survive, and they are not the same problem:

1. **The record** — which object, which upload id, which parts landed. The
   library can always keep this.
2. **The bytes** — access to the file itself. The library can only *sometimes*
   keep this, and that is what makes durable resume more involved than it looks.

A `File` object cannot be serialised. Persisting the record alone gets you a
perfect description of an upload you cannot continue.

## Turning it on

Pass a store. Without one, nothing is persisted and resume works only within the
page session.

```ts
import { createBatch, createIndexedDbStore } from "presigned-multipart-upload";

const store = createIndexedDbStore();

const batch = createBatch({ files, transport, store });
```

IndexedDB, not localStorage — it is the only web storage that can hold a file
handle, which the good recovery path depends on.

## The two recovery paths

### With a file handle

Where the browser supports the File System Access API, you can hold a durable
reference to the chosen file. Pass it alongside the file:

```ts
const [handle] = await window.showOpenFilePicker();
const file = await handle.getFile();

const batch = createBatch({
  files: [{ file, handle }],
  transport,
  store,
});
```

On return, the bytes come back with no involvement from the user beyond a
permission prompt.

### By re-selecting the file

Safari and Firefox do not support file handles. Neither does any browser when
the user drag-and-dropped rather than using the picker, or when they refuse the
permission prompt on return.

In those cases the user must choose the file again — and the library verifies it
is the same one before sending anything.

## Finding interrupted uploads

```ts
import { listResumable } from "presigned-multipart-upload";

const interrupted = await listResumable({ store });

for (const upload of interrupted) {
  console.log(upload.file.name, `${upload.landedParts}/${upload.totalParts} parts`);
  console.log(upload.recovery); // "handle" | "reselect"
}
```

`recovery` tells you which UI to show. You never have to test browser support
yourself.

## Continuing

To pick up everything recoverable without involving the user at all — every
record whose file handle still works — ask for `"all"`:

```ts
import { createResumedBatch } from "presigned-multipart-upload";

const batch = await createResumedBatch({ store, transport, resume: "all" });
await batch.resume();
```

Records needing the file re-selected are skipped, because only your application
can ask for it. Handle those explicitly:

```ts
import { createResumedBatch } from "presigned-multipart-upload";

// Resolve the files first: asking the user is asynchronous, and `resume` needs
// plain specs rather than a list of promises.
const specs = await Promise.all(
  interrupted.map(async (upload) => ({
    id: upload.id,
    // Required for "reselect"; ignored when a handle works.
    file: upload.recovery === "reselect" ? await askUserFor(upload.file) : undefined,
  })),
);

const batch = await createResumedBatch({ store, transport, resume: specs });

await batch.resume();
```

## The fingerprint

A user asked to find a file again can find the wrong one. Parts of two different
files spliced into one object would produce a corrupt result that nothing
downstream would notice.

So before a single byte is sent, the offered file is checked against the record:
**name, size and last-modified**. A mismatch refuses the resume with
`FINGERPRINT_MISMATCH` and sends nothing.

```ts
createResumedBatch({
  store,
  transport,
  resume: [{ id, file }],
  // Relax it if your flow legitimately renames files.
  fingerprint: { name: false },
});
```

This is metadata only, deliberately. Hashing a multi-gigabyte file on every
resume would cost far more than it protects, and metadata catches the realistic
mistake.

## How long a record lives

Records expire after seven days by default, and stale ones are cleaned up when
you call `listResumable`.

`recordTtlMs` is taken by **both** calls, and they do not share it. Pass it to
each, or `listResumable` will keep using its own seven-day default and go on
offering records your batch considers expired.

```ts
const TTL = 3 * 24 * 60 * 60 * 1000;

createBatch({ files, transport, store, recordTtlMs: TTL });
listResumable({ store, recordTtlMs: TTL });
```

Match this to your bucket's
[lifecycle rule](/guide/bucket-setup#lifecycle-rule). A record outliving the
upload it describes offers a resume that will fail at the provider.

Records are removed as soon as an upload succeeds or is cancelled, so finished
work never appears resumable.

## When the store itself fails

Browser storage runs out. A private-mode tab refuses to persist. Someone clears
site data mid-upload. Any of the four `RecordStore` methods may reject, and
`createIndexedDbStore` will.

**A failing store costs you durable resume and nothing else.** The upload in
flight is not failed, its siblings are not abandoned, and the parts that already
landed still land. The failure is reported to the console rather than swallowed,
so it stays diagnosable, and a record that could not be written simply is not
there to resume from later.

The exception is deliberate: `listResumable` and `createResumedBatch` reject if
the store cannot be read. You asked to read records; you are told when that
fails.

```ts
// Nothing to catch here — a store failure cannot fail this.
await createBatch({ files, transport, store }).start();

// This one can reject if the store is unreadable.
try {
  const interrupted = await listResumable({ store });
} catch {
  // Offer a fresh upload instead.
}
```

## Shared devices

By default every record in the store is visible to whoever opens the page. On a
shared machine that means one person could resume another's upload.

```ts
import { createIndexedDbStore, scopeStore } from "presigned-multipart-upload";

const store = scopeStore(createIndexedDbStore(), currentUser.id);
```

Records written under one owner are invisible to another. Scope by user id, and
your sign-out flow gets this right for free.

## What a full flow looks like

```ts
const store = scopeStore(createIndexedDbStore(), user.id);

// On load
const interrupted = await listResumable({ store, recordTtlMs: TTL });
if (interrupted.length > 0) {
  const chosen = await promptToContinue(interrupted); // your UI
  const batch = await createResumedBatch({
    store,
    transport,
    resume: chosen,
  });
  await batch.resume();
}
```

Handle `FINGERPRINT_MISMATCH` from `createResumedBatch` by telling the user they
picked a different file and offering to start over. Handle `FILE_REQUIRED` by
opening a file picker — it means the handle path was unavailable or refused.
