# Changelog

## 0.1.1

- `presigned-multipart-upload/package.json` is now exported, for tools that
  read a package's own metadata.

## 0.1.0

First public release: S3 multipart uploads for React and Angular.

- `useUploader` for React and `createAngularUploader` for Angular, on one Core
  with no runtime dependencies.
- `presigned-multipart-upload/server`: every endpoint the browser calls, as one
  web-standard handler, with `authorize`, `maxSize` and `allowedTypes`, and a
  Node / Express adapter.
- Parallel parts with retry and backoff, pause, resume, cancel, and resume
  after a page reload from IndexedDB.
- Progress that never goes backwards, with speed and time remaining.
- Small files as a single PUT; opt-in CRC32 checksums verified by S3.
- `presigned-multipart-upload/advanced` for custom Platforms, classifiers and
  record stores.
