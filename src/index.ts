// The public surface, kept deliberately small: every export here is a promise
// to keep it working. Internals (part planning, the semaphore, backoff maths,
// fingerprint comparison) are reachable from source paths for tests, but are
// not part of the contract.

export { createUploader } from "./uploader.js";
export type { UploaderSource } from "./uploader.js";
export { httpTransport } from "./http-transport.js";
export {
  PROVIDERS,
  // Value and type share each name, so one import gives both.
  PartStatus,
  UploadStatus,
  UploaderStatus,
  UploadErrorCode,
  UploadEvent,
} from "./types.js";
export { resumeUploader, listResumable } from "./resume.js";
export { browserPlatform } from "./platform/browser.js";
export { createIndexedDbStore, createMemoryStore, scopeStore } from "./store.js";
export { defaultClassifier } from "./classify.js";
export { UploadError } from "./errors.js";

export type { Classifier, ClassifyContext, RetryVerdict } from "./classify.js";
export type { FingerprintOptions } from "./fingerprint.js";
export type {
  ResumeUploaderOptions,
  ListResumableOptions,
  Recovery,
  ResumableUpload,
  ResumeSpec,
} from "./resume.js";
export type { RecordStore, UploadRecord } from "./store.js";
export type { HttpTransportOptions } from "./http-transport.js";
export type {
  Uploader,
  UploaderEvents,
  UploadFile,
  UploaderOptions,
  UploaderSnapshot,
  CompletedPart,
  EventName,
  FileDescriptor,
  OpenContext,
  OpenResult,
  SignPartsArgs,
  PartSnapshot,
  Platform,
  PlatformFiles,
  Progress,
  ProviderLimits,
  ResumeContext,
  SendPartArgs,
  SendPartResult,
  Transport,
  UploadErrorInfo,
  UploadInput,
  UploadSnapshot,
  UploadTuning,
} from "./types.js";
