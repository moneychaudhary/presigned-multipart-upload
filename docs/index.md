---
layout: home

hero:
  name: presigned-multipart-upload
  text: Uploads that survive
  tagline: Multipart uploads to presigned URLs that retry themselves, park when the network drops, and resume from the parts that never landed — in any framework, with no dependencies.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: The backend contract
      link: /guide/backend-contract

features:
  - title: Survives failure
    details: Transient failures retry with exponential backoff and full jitter. Going offline parks the work instead of spending the retry budget. An expired presigned URL re-opens for fresh ones rather than dying with an opaque 403.
  - title: Resumes rather than restarts
    details: When retries genuinely run out, the upload is left open at the provider and the parts that landed stay landed. One resume call finishes the job — including after a page reload.
  - title: Never holds your credentials
    details: The library consumes presigned URLs and nothing else. Opening, finalising and tearing down are three functions you implement against your own API, so authorisation, quota and object naming stay yours.
  - title: Any framework, or none
    details: A framework-independent core with thin bindings for React, Angular and Vue, and a documented recipe for anything else. Importing the core pulls in no framework, and there are no runtime dependencies at all.
---

## The shape of it

```ts
import { createBatch } from "presigned-multipart-upload";

const batch = createBatch({
  files: [file],
  transport: {
    open: (file, { partCount, resumeFrom, signal }) =>
      api.post("/uploads", { name: file.name, partCount, resumeFrom }, { signal }),
    complete: (args) => api.post("/uploads/complete", args),
    abort: (args) => api.post("/uploads/abort", args),
  },
});

batch.subscribe(({ status, progress }) => {
  console.log(status, `${progress.percent}%`);
});

await batch.start();
```

Everything else — retry, backoff, offline parking, URL expiry, resume — happens
underneath without you asking for it.

## Why this exists

Uploading a large file from a browser is a solved problem right up until
something goes wrong, and something always goes wrong: a laptop sleeps, a train
enters a tunnel, a proxy resets a connection, a presigned URL expires while four
gigabytes are still in flight, someone closes the tab at 90%.

Most implementations handle none of that. They fail the whole file when one part
drops, tear the upload down on first error so the bytes that did land are
discarded, and mint their URLs once so a long upload cannot outlive them.

This library is the machinery for the part after "it works on a good
connection".
