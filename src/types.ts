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
  now: () => number;
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
  /** One Presigned URL per Part, in Part order. */
  urls: string[];
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

export type BatchStatus =
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
  | "URL_COUNT_MISMATCH"
  | "MISSING_ETAG"
  | "RETRIES_EXHAUSTED"
  | "CANCELLED"
  | "PAUSED"
  | "TRANSPORT_OPEN_FAILED"
  | "TRANSPORT_COMPLETE_FAILED"
  | "NOT_RESUMABLE"
  | "FINGERPRINT_MISMATCH"
  | "FILE_REQUIRED"
  | "SEND_FAILED";

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

export interface BatchSnapshot {
  status: BatchStatus;
  progress: Progress;
  uploads: UploadSnapshot[];
}

export interface BatchEvents {
  "part:landed": { uploadId: string; partNumber: number };
  "part:retrying": { uploadId: string; partNumber: number; attempt: number; delayMs: number };
  "upload:succeeded": { uploadId: string };
  "upload:failed": { uploadId: string; error: UploadErrorInfo };
  "upload:cancelled": { uploadId: string };
  "upload:paused": { uploadId: string };
  "batch:settled": { status: BatchStatus };
}

export type EventName = keyof BatchEvents;

export interface ProviderLimits {
  /** Smallest Part accepted, except for the last. */
  minPartSize?: number;
  /** Most Parts accepted in one upload. */
  maxParts?: number;
}

const MIB = 1024 * 1024;

/** Named provider limits. All S3-compatible providers share S3's numbers. */
export const PROVIDERS = {
  s3: { minPartSize: 5 * MIB, maxParts: 10_000 },
  r2: { minPartSize: 5 * MIB, maxParts: 10_000 },
  b2: { minPartSize: 5 * MIB, maxParts: 10_000 },
  minio: { minPartSize: 5 * MIB, maxParts: 10_000 },
  wasabi: { minPartSize: 5 * MIB, maxParts: 10_000 },
} as const satisfies Record<string, Required<ProviderLimits>>;

export interface UploadTuning {
  /** Bytes per Part. Default 10 MiB. */
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

export type BatchFile = File | UploadInput;

export interface BatchOptions extends UploadTuning {
  files: BatchFile[];
  transport: Transport;
  platform?: Platform;
  /** Where Upload Records are kept. Omit to keep none, losing Durable Resume. */
  store?: RecordStore;
  /** How long an untouched Record stays resumable. Default 7 days. */
  recordTtlMs?: number;
  /** Which fields must match when a re-selected file is offered for a Resume. */
  fingerprint?: FingerprintOptions;
}

export interface BatchController {
  start: () => Promise<BatchSnapshot>;
  /** Continue Uploads that are paused or failed, from the Parts that never landed. */
  resume: (uploadId?: string) => Promise<BatchSnapshot>;
  /** Halt without discarding. Resumable. */
  pause: (uploadId?: string) => Promise<BatchSnapshot>;
  /** Discard. Tears the Upload down at the provider; terminal. */
  cancel: (uploadId?: string) => Promise<BatchSnapshot>;
  /**
   * The sole Upload's snapshot, for the common case of one file. Throws when
   * the Batch holds anything other than exactly one.
   */
  file: () => UploadSnapshot;
  getSnapshot: () => BatchSnapshot;
  subscribe: (listener: (snapshot: BatchSnapshot) => void) => () => void;
  on: <T extends EventName>(type: T, handler: (payload: BatchEvents[T]) => void) => () => void;
}
