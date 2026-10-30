// Extension points. Most applications never import from here.

export { browserPlatform } from "./platform/browser.js";
export { createIndexedDbStore } from "./platform/indexeddb-store.js";
export { createMemoryStore, scopeStore } from "./store.js";
export { defaultClassifier } from "./classify.js";
export { abortFailure, httpFailure, networkFailure, timeoutFailure } from "./failures.js";

export type { Classifier, ClassifyContext, RetryVerdict } from "./classify.js";
export type { FingerprintOptions } from "./fingerprint.js";
export type { RecordStore, UploadRecord } from "./store.js";
export type { Platform, PlatformFiles, SendPartArgs, SendPartResult } from "./types.js";
