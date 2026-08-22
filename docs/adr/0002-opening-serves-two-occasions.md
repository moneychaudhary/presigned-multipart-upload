# Opening serves two occasions rather than a separate refresh function

Presigned URLs expire, so a long Upload and every Resume need fresh ones. Rather
than adding a fourth Transport function to mint replacements, `open` takes a
`resumeFrom` argument and is always told which occasion it is serving: starting
fresh, or taking up an Upload that already exists. Both occasions return a
complete, usable set of URLs.

## Considered options

A dedicated `refreshPartUrls(key, uploadId, partNumbers)` was the obvious
alternative and reads more explicitly. It was rejected to keep the contract at
three functions: every adopter implements the Transport by hand against their
own API, and a smaller contract is less to get wrong. The cost is that `open`
carries two meanings, which is mitigated by `resumeFrom` making the occasion
explicit rather than something the backend has to infer.

## Consequences

Backends must not create a second multipart upload when `resumeFrom` is present
— they return the id they were given with fresh URLs. They must also verify that
the supplied key belongs to the caller, since `resumeFrom` arrives from the
client and would otherwise hand one user signed write access to another's
upload.

---

**Narrowed by [0005](./0005-presigned-urls-are-a-supply.md).** Opening still serves
its two occasions, but expiry is no longer inherently one of them: a Transport
that can sign named Parts repairs an expiry by re-signing instead.
