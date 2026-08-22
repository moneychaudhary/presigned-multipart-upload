# Bucket setup

Two pieces of configuration are required. Both fail in ways that are hard to
diagnose from the browser, so they are worth doing before your first upload
rather than after your first confusing bug report.

## CORS: expose the ETag header

Every part upload returns an `ETag`, and finalising the upload needs all of
them. Browsers hide response headers from JavaScript unless the server lists
them in `Access-Control-Expose-Headers`.

Without this, parts upload perfectly and then finalising rejects them — the
error arrives at the very end, pointing at nothing useful.

```json
[
  {
    "AllowedOrigins": ["https://app.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

The library detects this specific misconfiguration and fails immediately with
`MISSING_ETAG`, whose message names the fix — rather than letting you discover
it at completion time.

```bash
aws s3api put-bucket-cors \
  --bucket my-bucket \
  --cors-configuration file://cors.json
```

## Lifecycle rule

When retries run out, this library **leaves the multipart upload open** on
purpose. That is what makes resume possible: the parts that landed stay landed,
and a later resume finishes the job instead of re-sending gigabytes.

The cost is that an upload nobody ever comes back to sits there indefinitely,
and you are billed for its parts. Storage providers do not clean these up on
their own, and they are invisible in a normal object listing.

Set a lifecycle rule:

```json
{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart-uploads",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket my-bucket \
  --lifecycle-configuration file://lifecycle.json
```

Seven days is a reasonable default: long enough that someone returning the next
working day can still resume, short enough that abandoned work does not
accumulate. Match it to the record TTL you configure on the client — see
[durable resume](/guide/durable-resume#how-long-a-record-lives).

::: tip Check what is already there
Existing buckets often hold years of abandoned parts from whatever uploaded to
them before:

```bash
aws s3api list-multipart-uploads --bucket my-bucket
```
:::

## Part size limits

S3 and its compatibles impose limits the library enforces before sending
anything:

| Limit | Value | What the library does |
| --- | --- | --- |
| Minimum part size | 5 MiB, except the last part | Rejects a smaller `partSize` with `INVALID_PART_SIZE` |
| Maximum part size | 5 GiB | Rejects a larger `partSize` with `INVALID_PART_SIZE` |
| Maximum parts | 10,000 | Rejects with `PART_COUNT_EXCEEDED` |
| Maximum object | 5 TiB | Rejects with `FILE_TOO_LARGE` |

All four are checked before the Transport is asked to Open anything, so a file
that cannot be uploaded never leaves a dangling multipart upload behind.

They are configurable, because not every S3-compatible provider uses the same
numbers — pass `provider` as an object to state your own.

::: tip You do not have to size parts yourself
The 10,000-part cap would otherwise make a fixed part size a ceiling on file
size. Left unset, `partSize` is derived per file so that a 300 GiB upload plans
9,910 parts of 31 MiB rather than being refused. See
[very large files](/guide/large-files).
:::

## A note on transfer acceleration

If you presign against an accelerated endpoint, the URLs point there and this
library neither knows nor cares. The choice belongs entirely to your `open`
implementation.
