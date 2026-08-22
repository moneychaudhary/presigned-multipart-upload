# The backend contract

The library sends part bytes to presigned URLs. It does not sign them, does not
create the multipart upload, and does not finalise it. Those three things are
yours, because they are the points where authorisation, quota and object naming
belong — on your server, not in the browser.

That is the whole contract:

```ts
interface Transport {
  open(file, ctx): Promise<{ key: string; uploadId: string; urls: string[] }>;
  complete({ key, uploadId, parts }): Promise<unknown>;
  abort({ key, uploadId }): Promise<unknown>;
}
```

## `open`

Called to make an upload ready to receive parts. It is called on **two
occasions**, and it is always told which:

```ts
open(file, {
  partCount,          // how many parts the file was divided into
  partSize,
  resumeFrom,         // undefined on a fresh start; { key, uploadId } on a resume
  signal,
})
```

**When `resumeFrom` is undefined**, create a new multipart upload and return its
id.

**When `resumeFrom` is present**, do *not* create a second one. Return the
`uploadId` you were given, along with a fresh set of presigned URLs for the same
upload.

Both occasions must return usable URLs. This is deliberate: a URL minted an hour
ago may not be honoured now, and re-opening is how a long upload recovers from
its own URL expiry.

::: warning Return exactly one URL per part
`urls.length` must equal `partCount`. Too few and parts have nowhere to go; too
many usually means a stale list from an earlier opening, which would misalign
every part. The library rejects both rather than uploading to the wrong places.
:::

::: danger Verify `resumeFrom` before trusting it
`resumeFrom` arrives from the client. Check that the key belongs to the caller
before handing back fresh URLs for it, or one user could obtain signed write
access to another's upload.
:::

### Node example

```ts
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: "us-east-1" });

app.post("/api/uploads", async (req, res) => {
  const { name, partCount, resumeFrom } = req.body;

  // Your rules live here: who may upload, how much, and under what key.
  await assertQuota(req.user, req.body.size);
  const key = resumeFrom?.key ?? `users/${req.user.id}/${crypto.randomUUID()}/${name}`;

  const uploadId =
    resumeFrom?.uploadId ??
    (await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key })))
      .UploadId;

  const urls = await Promise.all(
    Array.from({ length: partCount }, (_, i) =>
      getSignedUrl(
        s3,
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: key,
          UploadId: uploadId,
          PartNumber: i + 1,
        }),
        { expiresIn: 3600 },
      ),
    ),
  );

  res.json({ key, uploadId, urls });
});
```

## `complete`

Called once every part has landed. Parts arrive **sorted ascending by part
number**, each with the ETag the storage provider returned.

```ts
app.post("/api/uploads/complete", async (req, res) => {
  const { key, uploadId, parts } = req.body;

  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.eTag })),
      },
    }),
  );

  res.json({ ok: true });
});
```

ETags are passed through exactly as the provider returned them, quotes included,
because that is the form completion expects.

## `abort`

Called when an upload is **cancelled** — a deliberate decision to discard the
work.

```ts
app.post("/api/uploads/abort", async (req, res) => {
  const { key, uploadId } = req.body;
  await s3.send(
    new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId }),
  );
  res.json({ ok: true });
});
```

::: danger `abort` is not called on failure
When retries run out, the upload is deliberately **left open** so it can be
resumed — that is the entire point of the library. Nothing tears it down for
you.

This means abandoned uploads accumulate and cost storage. Set a lifecycle rule.
See [bucket setup](/guide/bucket-setup#lifecycle-rule).
:::

## A full Python implementation

Same contract, using boto3. FastAPI here, but nothing depends on the framework.

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
        key = body.resumeFrom.key
        upload_id = body.resumeFrom.uploadId
    else:
        key = f"users/{user.id}/{uuid.uuid4()}/{body.name}"
        upload_id = s3.create_multipart_upload(Bucket=BUCKET, Key=key)["UploadId"]

    urls = [
        s3.generate_presigned_url(
            "upload_part",
            Params={
                "Bucket": BUCKET,
                "Key": key,
                "UploadId": upload_id,
                "PartNumber": part_number,
            },
            ExpiresIn=3600,
        )
        # Part numbers start at 1, and there must be exactly partCount of them.
        for part_number in range(1, body.partCount + 1)
    ]

    return {"key": key, "uploadId": upload_id, "urls": urls}
```

```python
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
        Bucket=BUCKET,
        Key=body.key,
        UploadId=body.uploadId,
        MultipartUpload={
            # Already sorted ascending by the client; the ETags are passed
            # through exactly as S3 returned them, quotes included.
            "Parts": [
                {"PartNumber": p.partNumber, "ETag": p.eTag} for p in body.parts
            ]
        },
    )
    return {"ok": True}


class AbortRequest(BaseModel):
    key: str
    uploadId: str


@router.post("/api/uploads/abort")
def abort_upload(body: AbortRequest, user=Depends(current_user)):
    if not owns_key(user, body.key):
        raise HTTPException(403, "Not your upload")

    s3.abort_multipart_upload(
        Bucket=BUCKET, Key=body.key, UploadId=body.uploadId
    )
    return {"ok": True}
```

::: tip Django, Flask, anything else
Only the routing changes. The three operations are `create_multipart_upload`,
`generate_presigned_url("upload_part", ...)` and `complete_multipart_upload` /
`abort_multipart_upload` — identical whatever serves them.
:::

## Any S3-compatible provider

Nothing here is AWS-specific. The same three functions work against Cloudflare
R2, MinIO, Backblaze B2, Wasabi, Ceph — anything speaking the S3 multipart API.
The library never imports a storage SDK; yours does.

## Errors from the Transport

If your `open` rejects, the upload fails with `TRANSPORT_OPEN_FAILED`. If
`complete` rejects, `TRANSPORT_COMPLETE_FAILED`. A failing `abort` is swallowed —
tearing down is best-effort, and the lifecycle rule is the backstop.

See the [errors reference](/reference/errors).
