// The public surface, kept deliberately small: every export here is a promise
// to keep it working. Internals (part planning, the semaphore, backoff maths,
// fingerprint comparison) are reachable from source paths for tests, but are
// not part of the contract.

export { createUploader } from "./uploader.js";
export { httpTransport } from "./http-transport.js";
export { PROVIDERS } from "./types.js";
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
  UploaderStatus,
  CompletedPart,
  EventName,
  FileDescriptor,
  OpenContext,
  OpenResult,
  SignPartsArgs,
  PartSnapshot,
  PartStatus,
  Platform,
  PlatformFiles,
  Progress,
  ProviderLimits,
  ResumeContext,
  SendPartArgs,
  SendPartResult,
  Transport,
  UploadErrorCode,
  UploadErrorInfo,
  UploadInput,
  UploadSnapshot,
  UploadStatus,
  UploadTuning,
} from "./types.js";
