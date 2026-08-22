# Very large files

Nothing here changes the API, but four things scale with the file and it is
worth knowing which.

## Part size is chosen for you

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

## Memory is `partSize` × `concurrency`

Parts are read from the file lazily, so the file itself is never in memory. The
**parts in flight** are. With the default `concurrency` of 5, a 300 GiB file at
31 MiB parts holds roughly **155 MiB** — fine on a desktop, tight on an old
phone.

That is the tradeoff to weigh if you are tempted to raise `partSize` for
throughput. Lower `concurrency` in the same breath:

```ts
createBatch({ files, transport, partSize: 128 * 1024 * 1024, concurrency: 2 });
```

## Your `open` signs one URL per part

This is the cost most people miss. `open` must return `partCount` URLs, and for
a 300 GiB file that is ~9,900 of them — several megabytes of JSON, and several
thousand signatures computed per request. Signing is local and cheap (no call to
AWS), but it is not free, and **it happens again on every re-open**.

If that response size matters to you, raising `partSize` is the lever: 128 MiB
parts turn 9,910 URLs into 2,400.

## It will outlive its URLs

300 GiB at 100 Mbps is around seven hours; presigned URLs typically last one. The
library handles this — a 403 on a part triggers a **refresh** for fresh URLs and
the run continues from where it was. Parts in flight share their URLs' expiry, so
five parts meeting it at once cost one refresh between them, not five. Where you
supply `signParts` the refresh re-signs those parts; where you do not, it re-opens.
Two things on your side make it work:

- Return **fresh URLs** every time, including when `resumeFrom` is present.
  Replaying a stale list is the one way to break this.
- Set your bucket's lifecycle rule generously enough that a legitimate long
  upload is not swept away mid-flight. See [bucket setup](/guide/bucket-setup).

## What the store actually holds

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
