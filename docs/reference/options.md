# Options

Everything has a working default. Nothing below is required except `files` and
`transport`.

```ts
createBatch({
  files,
  transport,

  platform,          // swap the door to the outside world (mainly for tests)
  store,             // enables durable resume
  recordTtlMs,

  partSize,
  provider,
  concurrency,

  maxRetries,
  retryBaseMs,
  retryMaxMs,
  partTimeoutMs,
  waitWhileOffline,
  classify,

  contentType,
  fingerprint,
});
```

## Required

### `files`

`Array<File | { file: File; handle?: unknown }>`

The files to upload. Pass one and the batch has one upload — there is no
separate single-file API.

The object form carries a File System Access handle, which is what allows
[durable resume](/guide/durable-resume) without asking the user to find the file
again.

### `transport`

Your three backend functions. See [the backend contract](/guide/backend-contract).

## Sizing

### `partSize`

`number` — default `10 MiB`

Bytes per part. Larger parts mean fewer requests and less overhead; smaller
parts mean less to re-send when one fails.

The defaults handle files up to about 97 GiB before hitting the part limit.

### `provider`

`"s3" | "r2" | "b2" | "minio" | "wasabi" | { minPartSize?, maxParts? }` — default `"s3"`

The storage provider's limits. These are facts about the provider rather than
preferences, so they live together and out of the way:

- **minimum part size** — the floor for every part except the last. A smaller
  `partSize` is rejected with `INVALID_PART_SIZE` before anything is sent.
- **maximum parts** — exceeding it fails with `PART_COUNT_EXCEEDED` and a
  message suggesting a larger part size.

Every S3-compatible provider currently shares S3's numbers, so the named presets
are equivalent — they exist so the choice is explicit rather than a thing you
have to look up. Pass an object for anything unusual.

### `concurrency`

`number` — default `5`

Parts in flight across the **whole batch**, not per upload.

Browsers cap simultaneous connections per host — six in Chrome and Firefox.
Exceeding it does not fail loudly: the surplus queues below the network layer
where it reports no progress and can time out having never been sent. One queue
serves the whole batch, so every part the library believes is in flight really is
on the wire, however many files you hand it.

## Retry

### `maxRetries`

`number` — default `3`

Retries **after** the first attempt, per part. The default means four tries in
all. The budget is per part, not shared across the upload.

### `retryBaseMs` / `retryMaxMs`

`number` — defaults `500` / `15 000`

The backoff window doubles each attempt, capped at `retryMaxMs`, with full
jitter applied across the whole window. See [retry and backoff](/guide/retry).

### `partTimeoutMs`

`number` — default `0` (disabled)

Per-attempt timeout. A timeout is classified as retryable. Worth setting if
hung connections are a problem in your environment; leave at 0 if slow-but-alive
uploads are normal.

### `waitWhileOffline`

`boolean` — default `true`

Park and wait for connectivity instead of spending retries. Set `false` to fail
fast.

### `classify`

`(error, ctx) => "retry" | "reopen" | "fatal"`

Replace the rule deciding what is worth repeating. See
[replacing the rule](/guide/retry#replacing-the-rule).

## Durability

### `store`

`RecordStore`

Where upload records are kept. Without one, nothing persists and resume works
only within the page session.

Ships with `createIndexedDbStore()` and `createMemoryStore()`, plus
`scopeStore(inner, owner)` to keep one signed-in user's records invisible to the
next.

### `recordTtlMs`

`number` — default 7 days

How long an untouched record stays resumable. Match it to your bucket's
lifecycle rule.

### `fingerprint`

`{ name?: boolean; size?: boolean; lastModified?: boolean }`

Which fields must match when a re-selected file is offered for a resume. All
three are checked by default. See [the fingerprint](/guide/durable-resume#the-fingerprint).

## Other

### `contentType`

`string` — defaults to each file's own `type`

Sent with every part.

### `platform`

`Platform`

The single door between the library and the outside world: sending bytes,
time, randomness, connectivity and file handles. Replace it to test your own
integration deterministically, or to run outside a browser.

```ts
import { browserPlatform } from "presigned-multipart-upload";

createBatch({ files, transport, platform: { ...browserPlatform(), random: () => 0.5 } });
```
