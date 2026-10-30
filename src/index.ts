// What most applications need: build an Uploader (or let the React or Angular
// binding build one), talk to your backend, and take uploads back up after a
// reload. Extension points — a custom Platform, failure shapes, the
// classifier, Record Stores — live in "presigned-multipart-upload/advanced".

export { createUploader } from "./uploader.js";
export type { UploaderSource } from "./uploader.js";
export { httpTransport } from "./http-transport.js";
export { resumeUploader, listResumable } from "./resume.js";
export { UploadError } from "./errors.js";
export {
  // Value and type share each name, so one import gives both.
  PartStatus,
  UploadStatus,
  UploaderStatus,
  UploadErrorCode,
  UploadEvent,
  S3_LIMITS,
} from "./types.js";

export type {
  ResumeUploaderOptions,
  ListResumableOptions,
  Recovery,
  ResumableUpload,
  ResumeSpec,
} from "./resume.js";
export type { HttpTransportOptions } from "./http-transport.js";
export type {
  Uploader,
  UploaderEvents,
  UploaderOptions,
  UploaderSnapshot,
  UploadSnapshot,
  PartSnapshot,
  Progress,
  UploadErrorInfo,
  UploadFile,
  UploadInput,
  UploadTuning,
  RetryOptions,
  S3Limits,
  ChecksumAlgorithm,
  EventName,
  FileDescriptor,
  // Your backend's contract, for writing a Transport of your own.
  Transport,
  UploadTarget,
  OpenContext,
  OpenResult,
  OpenSingleContext,
  OpenSingleResult,
  SignPartsArgs,
  CompleteArgs,
  CompletedPart,
} from "./types.js";
