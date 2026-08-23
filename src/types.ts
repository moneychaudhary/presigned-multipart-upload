import type { Classifier } from "./classify.js";
import type { FingerprintOptions } from "./fingerprint.js";
import type { RecordStore } from "./store.js";

/** Everything the Core needs to know about a file without holding one. */
export interface FileDescriptor {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export interface SendPartArgs {
  url: string;
  body: Blob;
  /** Which Upload this Part belongs to. Part numbers repeat across Uploads. */
  uploadId: string;
  partNumber: number;
  contentType: string | undefined;
  timeoutMs: number;
  signal: AbortSignal;
  onProgress: ((loaded: number) => void) | undefined;
}

export interface SendPartResult {
  /** Null when the response carried no readable ETag — the CORS misconfiguration. */
  eTag: string | null;
}

export interface PlatformFiles {
  /** Whether this browser can hold a durable reference to a chosen file. */
  isHandleSupported: () => boolean;
  /** Re-ask for read access; returning false forces the re-selection path. */
  requestPermission: (handle: unknown) => Promise<boolean>;
  /** Re-open a stored handle to get the bytes back. */
  readFile: (handle: unknown) => Promise<File>;
}

/**
 * The single door between the Core and the outside world.
 *
 * Nothing in the Core may reach past this — no timers, no randomness, no
 * network, no storage. That is what makes every behaviour deterministic under
 * test without mocking internals.
 */
export interface Platform {
  sendPart: (args: SendPartArgs) => Promise<SendPartResult>;
  /**
   * A fresh identifier for an Upload.
   *
   * Must be unique across every Batch that could share a Record Store — which
   * includes Batches in other tabs and in later page sessions. The identifier is
   * the Upload Record's key, so a repeat silently overwrites another Upload's
   * Record and strands its multipart upload open at the provider.
   */
  newId: () => string;
  now: () => number;
  /**
   * Wait, interruptibly.
   *
   * Must **resolve** when the signal aborts, never reject. The usual convention
   * for an abortable sleep is to reject with an `AbortError`, and following it
   * here turns a Pause into a failure: the Core sleeps inside its Retry handler,
   * so a rejection unwinds past the check that would have settled the Upload as
   * paused. Resolving early lets that check run.
   */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  isOnline: () => boolean;
  onOnline: (listener: () => void) => () => void;
  /** Only needed for Durable Resume via a File Handle. */
  files?: PlatformFiles;
}

export interface ResumeContext {
  key: string;
  uploadId: string;
}

export interface OpenContext {
  partCount: number;
  partSize: number;
  /** Present only when taking up an Upload that already exists. */
  resumeFrom: ResumeContext | undefined;
  signal: AbortSignal;
}

export interface OpenResult {
  key: string;
  uploadId: string;
  /**
   * One Presigned URL per Part, in Part order.
   *
   * Omit when the Transport supplies `signParts`, which mints them a window at
   * a time instead. Supplying both is allowed: these are used first.
   */
  urls?: string[];
}

export interface SignPartsArgs {
  key: string;
  uploadId: string;
  /** The Parts about to be sent. Return a url for each; more is allowed. */
  partNumbers: number[];
  signal: AbortSignal;
}

export interface CompletedPart {
  partNumber: number;
  eTag: string;
}

/**
 * The application's own API, through which an Upload is Opened, finalised and
 * torn down. Only Part bytes travel to a Presigned URL; these three do not.
 */
export interface Transport {
  open: (file: FileDescriptor, ctx: OpenContext) => Promise<OpenResult>;
  /**
   * Mint Presigned URLs for named Parts, keyed by Part number.
   *
   * Optional, and worth supplying once Uploads are large enough that signing
   * every Part up front is wasteful: a 300 GiB file is ~9,900 Parts, so an
   * Opening that signs them all returns several megabytes of urls, most of
   * which expire before they are reached. With this, the library signs a window
   * just ahead of what it is sending, and recovers from an expiry by re-signing
   * the Parts affected rather than re-Opening the whole Upload.
   */
  signParts?: (args: SignPartsArgs) => Promise<Record<number, string>>;
  complete: (args: {
    key: string;
    uploadId: string;
    parts: CompletedPart[];
  }) => Promise<unknown>;
  abort: (args: { key: string; uploadId: string }) => Promise<unknown>;
}

export type PartStatus = "pending" | "uploading" | "landed" | "failed";

export type UploadStatus =
  | "pending"
  | "opening"
  | "uploading"
  | "completing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "paused";

export type UploaderStatus =
  | "idle"
  | "uploading"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "paused";

export type UploadErrorCode =
  | "EMPTY_FILE"
  | "INVALID_PART_SIZE"
  | "PART_COUNT_EXCEEDED"
  | "FILE_TOO_LARGE"
  | "URL_COUNT_MISMATCH"
  | "URL_MISSING"
  | "MISSING_ETAG"
  | "RETRIES_EXHAUSTED"
  | "CANCELLED"
  | "PAUSED"
  | "TRANSPORT_OPEN_FAILED"
  | "TRANSPORT_COMPLETE_FAILED"
  | "NOT_RESUMABLE"
  | "FINGERPRINT_MISMATCH"
  | "FILE_REQUIRED"
  | "SEND_FAILED"
  /** A request to the application's own API failed, rather than to storage. */
  | "TRANSPORT_REQUEST_FAILED"
  /** Nothing that understood the failure attributed it. */
  | "UNKNOWN";

export interface UploadErrorInfo {
  code: UploadErrorCode;
  message: string;
}

export interface Progress {
  loaded: number;
  total: number;
  /** 0–100, rounded to two decimals. */
  percent: number;
}

export interface PartSnapshot {
  partNumber: number;
  start: number;
  end: number;
  size: number;
  status: PartStatus;
  loaded: number;
  attempts: number;
  eTag: string | null;
}

export interface UploadSnapshot {
  id: string;
  file: FileDescriptor;
  status: UploadStatus;
  progress: Progress;
  parts: PartSnapshot[];
  key: string | null;
  uploadId: string | null;
  error: UploadErrorInfo | null;
  /** True when this Upload has work left that a Resume would pick up. */
  resumable: boolean;
}

export interface UploaderSnapshot {
  status: UploaderStatus;
  progress: Progress;
  uploads: UploadSnapshot[];
  /**
   * The sole Upload, for the common case of one file; null for any other count.
   *
   * Derived here rather than in each Adapter, so every framework binding gets
   * it for nothing and none of them has to decide what "not exactly one" means.
   */
  file: UploadSnapshot | null;
}

/**
 * `id` throughout is the library's own identifier for an Upload —
 * `UploadSnapshot.id`, and what `resume`, `pause` and `cancel` match on.
 *
 * Not `uploadId`, which on a snapshot means the storage provider's multipart
 * identifier. They used to share the name here, so `batch.resume(upload.uploadId)`
 * compiled, read as obviously right, and threw.
 */
export interface UploaderEvents {
  "part:landed": { id: string; partNumber: number };
  "part:retrying": { id: string; partNumber: number; attempt: number; delayMs: number };
  "upload:succeeded": { id: string };
  "upload:failed": { id: string; error: UploadErrorInfo };
  "upload:cancelled": { id: string };
  "upload:paused": { id: string };
  "uploader:settled": { status: UploaderStatus };
}

export type EventName = keyof UploaderEvents;

export interface ProviderLimits {
  /** Smallest Part accepted, except for the last. */
  minPartSize?: number;
  /** Most Parts accepted in one upload. */
  maxParts?: number;
  /** Largest Part accepted. */
  maxPartSize?: number;
  /** Largest object the provider will assemble from those Parts. */
  maxObjectSize?: number;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const TIB = 1024 * GIB;

/**
 * Named provider limits. All S3-compatible providers share S3's numbers.
 *
 * Where a provider is in fact more generous (B2 assembles objects up to 10 TB),
 * S3's figure is used anyway: it is the safe common denominator, and anyone who
 * needs the extra can pass the limits explicitly.
 */
export const PROVIDERS = {
  s3: { minPartSize: 5 * MIB, maxParts: 10_000, maxPartSize: 5 * GIB, maxObjectSize: 5 * TIB },
  r2: { minPartSize: 5 * MIB, maxParts: 10_000, maxPartSize: 5 * GIB, maxObjectSize: 5 * TIB },
  b2: { minPartSize: 5 * MIB, maxParts: 10_000, maxPartSize: 5 * GIB, maxObjectSize: 5 * TIB },
  minio: { minPartSize: 5 * MIB, maxParts: 10_000, maxPartSize: 5 * GIB, maxObjectSize: 5 * TIB },
  wasabi: { minPartSize: 5 * MIB, maxParts: 10_000, maxPartSize: 5 * GIB, maxObjectSize: 5 * TIB },
} as const satisfies Record<string, Required<ProviderLimits>>;

export interface UploadTuning {
  /**
   * Bytes per Part.
   *
   * Left out, this is chosen per file: 10 MiB, or the smallest whole MiB that
   * keeps the file inside the provider's Part limit, whichever is larger. A
   * 300 GB file needs Parts of at least ~30.7 MiB to fit in 10,000 of them, so
   * a fixed default would refuse it outright.
   *
   * Set it only to override that. Remember the memory cost: `concurrency`
   * Parts are in flight at once, so `partSize x concurrency` is roughly the
   * ceiling on what the tab holds.
   */
  partSize?: number;
  /**
   * Which storage provider's limits apply. These are facts about the provider,
   * not preferences — grouping them keeps them out of the way of the knobs you
   * might actually want to turn. Default "s3", which suits every
   * S3-compatible provider.
   */
  provider?: ProviderLimits | keyof typeof PROVIDERS;
  /** Parts in flight across the whole Batch. Default 5. */
  concurrency?: number;
  /** Retries after the first Attempt, per Part. Default 3 — so 4 tries in all. */
  maxRetries?: number;
  /** Base backoff in ms, doubled per Attempt. Default 500. */
  retryBaseMs?: number;
  /** Backoff ceiling in ms. Default 15000. */
  retryMaxMs?: number;
  /** Per-Attempt timeout in ms; 0 disables. Default 0. */
  partTimeoutMs?: number;
  /** Park instead of Retrying while the browser reports itself offline. Default true. */
  waitWhileOffline?: boolean;
  /** Content-Type sent with each Part. Defaults to the file's own type. */
  contentType?: string;
  /** Replace the rule deciding what is worth Retrying. */
  classify?: Classifier;
  /**
   * How many Parts to sign ahead when the Transport supplies `signParts`.
   * Default 4x concurrency. Ignored when it does not.
   */
  urlWindow?: number;
}

/**
 * A file, optionally paired with a durable handle to it.
 *
 * Supplying the handle is what lets an interrupted Upload be Resumed after a
 * reload without asking the user to find their file again.
 */
export interface UploadInput {
  file: File;
  handle?: unknown;
}

export type UploadFile = File | UploadInput;

export interface UploaderOptions extends UploadTuning {
  files: UploadFile[];
  transport: Transport;
  platform?: Platform;
  /** Where Upload Records are kept. Omit to keep none, losing Durable Resume. */
  store?: RecordStore;
  /** How long an untouched Record stays resumable. Default 7 days. */
  recordTtlMs?: number;
  /** Which fields must match when a re-selected file is offered for a Resume. */
  fingerprint?: FingerprintOptions;
}

export interface Uploader {
  start: () => Promise<UploaderSnapshot>;
  /** Continue Uploads that are paused or failed, from the Parts that never landed. */
  resume: (id?: string) => Promise<UploaderSnapshot>;
  /** Halt without discarding. Resumable. */
  pause: (id?: string) => Promise<UploaderSnapshot>;
  /** Discard. Tears the Upload down at the provider; terminal. */
  cancel: (id?: string) => Promise<UploaderSnapshot>;
  getSnapshot: () => UploaderSnapshot;
  subscribe: (listener: (snapshot: UploaderSnapshot) => void) => () => void;
  on: <T extends EventName>(type: T, handler: (payload: UploaderEvents[T]) => void) => () => void;
}
