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
  /**
   * The library's id for the Upload this Part belongs to — `UploadSnapshot.id`,
   * not the provider's `uploadId`. Part numbers repeat across Uploads.
   */
  id: string;
  partNumber: number;
  /**
   * Request headers to send with the bytes: `Content-Type`, and the checksum
   * header when checksums are on. Send them exactly as given — a checksum
   * header is part of the Presigned URL's signature.
   */
  headers: Record<string, string>;
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
  /**
   * Call `run` every `ms` until the returned function is called. Optional: the
   * Core uses it only to let a stalled transfer's speed lapse on screen, and
   * without it speed refreshes whenever anything else changes.
   */
  every?: (ms: number, run: () => void) => () => void;
  /** Only needed for Durable Resume via a File Handle. */
  files?: PlatformFiles;
}

/** Where an Opened Upload is being written: the object key and the provider's multipart id. */
export interface UploadTarget {
  key: string;
  uploadId: string;
}

/** The checksums the library can compute. Named as S3 names them. */
export type ChecksumAlgorithm = "CRC32";

export interface OpenContext {
  partCount: number;
  partSize: number;
  /** Present only when taking up an Upload that already exists. Reuse it. */
  resumeFrom: UploadTarget | undefined;
  /**
   * Set when checksums are on. Pass it as `ChecksumAlgorithm` when creating the
   * multipart upload, or the provider will not expect the Parts' checksums.
   */
  checksumAlgorithm?: ChecksumAlgorithm | undefined;
  signal: AbortSignal;
}

export interface OpenSingleContext {
  /**
   * The whole file's CRC32, base64, when checksums are on. Sign it into the
   * url as `ChecksumCRC32`; the library sends the matching header.
   */
  checksumCRC32?: string | undefined;
  signal: AbortSignal;
}

export interface OpenSingleResult {
  key: string;
  /** A Presigned URL for one PUT of the whole file. */
  url: string;
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

export interface SignPartsArgs extends UploadTarget {
  /** The Parts about to be sent. Return a url for each; more is allowed. */
  partNumbers: number[];
  /**
   * Each Part's CRC32, base64, keyed by Part number — present when checksums
   * are on. Sign each into its url as `ChecksumCRC32`, so the provider checks
   * the bytes against it; the library sends the matching header.
   */
  checksumsCRC32?: Record<number, string> | undefined;
  signal: AbortSignal;
}

export interface CompletedPart {
  partNumber: number;
  eTag: string;
  /** Present when checksums are on. Pass it through as the Part's `ChecksumCRC32`. */
  checksumCRC32?: string;
}

export interface CompleteArgs extends UploadTarget {
  /** Every Part, ascending by number — the order finalising requires. */
  parts: CompletedPart[];
}

/**
 * The application's own API, through which an Upload is Opened, finalised and
 * torn down. Only Part bytes travel to a Presigned URL; these calls do not.
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
  /**
   * Sign one plain PUT for a whole file. Optional.
   *
   * When supplied, a file that fits in a single Part skips multipart entirely:
   * one request to sign, one PUT, nothing to finalise or tear down. Small files
   * are most files, and multipart costs them two extra round trips.
   */
  openSingle?: (file: FileDescriptor, ctx: OpenSingleContext) => Promise<OpenSingleResult>;
  complete: (args: CompleteArgs) => Promise<unknown>;
  abort: (args: UploadTarget) => Promise<unknown>;
}

/*
 * The values a snapshot reports, each as a constant beside its type.
 *
 * `snapshot.status === UploaderStatus.Succeeded` says what it means and a typo
 * in it is a compile error, where `=== "suceeded"` is a branch that silently
 * never runs. The types are derived from the constants, so the two cannot
 * drift; the string values are the contract and are safe to compare against
 * directly if you prefer.
 */

export const PartStatus = {
  Pending: "pending",
  Uploading: "uploading",
  Landed: "landed",
  Failed: "failed",
} as const;

export type PartStatus = (typeof PartStatus)[keyof typeof PartStatus];

export const UploadStatus = {
  Pending: "pending",
  Opening: "opening",
  Uploading: "uploading",
  Completing: "completing",
  Succeeded: "succeeded",
  Failed: "failed",
  Cancelled: "cancelled",
  Paused: "paused",
} as const;

export type UploadStatus = (typeof UploadStatus)[keyof typeof UploadStatus];

export const UploaderStatus = {
  Idle: "idle",
  Uploading: "uploading",
  Succeeded: "succeeded",
  Failed: "failed",
  Cancelled: "cancelled",
  Paused: "paused",
} as const;

export type UploaderStatus = (typeof UploaderStatus)[keyof typeof UploaderStatus];

export const UploadErrorCode = {
  /** An argument to a public entry point was the wrong shape. */
  InvalidOptions: "INVALID_OPTIONS",
  EmptyFile: "EMPTY_FILE",
  InvalidPartSize: "INVALID_PART_SIZE",
  PartCountExceeded: "PART_COUNT_EXCEEDED",
  FileTooLarge: "FILE_TOO_LARGE",
  /** Opening returned the wrong number of urls for the Parts planned. */
  UrlCountMismatch: "URL_COUNT_MISMATCH",
  /** A Resume was answered with a different Upload than the one asked for. */
  ResumeMismatch: "RESUME_MISMATCH",
  /** `signParts` skipped a Part it was asked to sign. */
  UrlMissing: "URL_MISSING",
  MissingETag: "MISSING_ETAG",
  RetriesExhausted: "RETRIES_EXHAUSTED",
  /** Your open endpoint failed or answered with the wrong shape. */
  TransportOpenFailed: "TRANSPORT_OPEN_FAILED",
  /** Your sign endpoint kept failing, or answered with the wrong shape. */
  TransportSignFailed: "TRANSPORT_SIGN_FAILED",
  /** Your complete endpoint failed. */
  TransportCompleteFailed: "TRANSPORT_COMPLETE_FAILED",
  NotResumable: "NOT_RESUMABLE",
  FingerprintMismatch: "FINGERPRINT_MISMATCH",
  FileRequired: "FILE_REQUIRED",
  SendFailed: "SEND_FAILED",
  /** Nothing that understood the failure attributed it. */
  Unknown: "UNKNOWN",
} as const;

export type UploadErrorCode = (typeof UploadErrorCode)[keyof typeof UploadErrorCode];

export interface UploadErrorInfo {
  code: UploadErrorCode;
  message: string;
}

/*
 * Snapshots are frozen when handed out, and typed to say so: assigning to one
 * is a compile error rather than a TypeError at runtime.
 */

export interface Progress {
  /** Bytes stored or on their way. Never goes down, even when a Part is Retried. */
  readonly loaded: number;
  readonly total: number;
  /** 0–100, rounded to two decimals. */
  readonly percent: number;
  /**
   * Recent transfer speed, averaged over the last few seconds. Null until there
   * is enough to measure, and whenever nothing is moving — paused, finished,
   * failed, or not yet started.
   */
  readonly bytesPerSecond: number | null;
  /** Estimated time left at `bytesPerSecond`. Null whenever that is. */
  readonly remainingMs: number | null;
}

export interface PartSnapshot {
  readonly partNumber: number;
  readonly start: number;
  readonly end: number;
  readonly size: number;
  readonly status: PartStatus;
  readonly loaded: number;
  readonly attempts: number;
  readonly eTag: string | null;
  /** The Part's CRC32, base64, once computed. Null when checksums are off. */
  readonly checksumCRC32: string | null;
}

export interface UploadSnapshot {
  readonly id: string;
  readonly file: FileDescriptor;
  readonly status: UploadStatus;
  readonly progress: Progress;
  readonly parts: readonly PartSnapshot[];
  readonly key: string | null;
  readonly uploadId: string | null;
  readonly error: UploadErrorInfo | null;
  /** True when this Upload has work left that a Resume would pick up. */
  readonly resumable: boolean;
}

export interface UploaderSnapshot {
  readonly status: UploaderStatus;
  readonly progress: Progress;
  readonly uploads: readonly UploadSnapshot[];
  /**
   * The sole Upload, for the common case of one file; null for any other count.
   *
   * Derived here rather than in each Adapter, so every framework binding gets
   * it for nothing and none of them has to decide what "not exactly one" means.
   */
  readonly upload: UploadSnapshot | null;
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

/**
 * The event names, so `on` is called with a constant rather than a literal.
 *
 * Checked against `UploaderEvents`, so renaming an event breaks here rather
 * than at the call site of whoever subscribed to the old name.
 */
export const UploadEvent = {
  PartLanded: "part:landed",
  PartRetrying: "part:retrying",
  UploadSucceeded: "upload:succeeded",
  UploadFailed: "upload:failed",
  UploadCancelled: "upload:cancelled",
  UploadPaused: "upload:paused",
  Settled: "uploader:settled",
} as const satisfies Record<string, EventName>;

/** S3's limits on a multipart upload. */
export interface S3Limits {
  /** Smallest Part accepted, except for the last. */
  minPartSize: number;
  /** Most Parts accepted in one upload. */
  maxParts: number;
  /** Largest Part accepted. */
  maxPartSize: number;
  /** Largest object S3 will assemble from those Parts. */
  maxObjectSize: number;
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const TIB = 1024 * GIB;

export const S3_LIMITS: Readonly<S3Limits> = Object.freeze({
  minPartSize: 5 * MIB,
  maxParts: 10_000,
  maxPartSize: 5 * GIB,
  maxObjectSize: 5 * TIB,
});

/** How a failed Part is tried again. */
export interface RetryOptions {
  /** Retries after the first Attempt, per Part. Default 3 — so 4 tries in all. */
  max?: number;
  /** Base backoff in ms, doubled per Attempt, with full jitter. Default 500. */
  baseMs?: number;
  /** Backoff ceiling in ms. Default 15000. */
  maxMs?: number;
  /** Per-Attempt timeout in ms; 0 disables. Default 0. */
  timeoutMs?: number;
}

export interface UploadTuning {
  /**
   * Bytes per Part.
   *
   * Left out, this is chosen per file: 10 MiB, or the smallest whole MiB that
   * keeps the file inside S3's 10,000-Part limit, whichever is larger. Set it
   * only to override that: `partSize x concurrency` is roughly what the tab holds.
   */
  partSize?: number;
  /** Parts in flight across the whole Batch. Default 5. */
  concurrency?: number;
  retry?: RetryOptions;
  /**
   * Have S3 verify every Part against a CRC32 the library computes from the
   * file. Off by default. Needs a Transport with `signParts`: a checksum only
   * binds when it is signed into the url.
   */
  checksum?: ChecksumAlgorithm;

  /* Advanced — most applications never set these. */

  /** Wait instead of Retrying while the browser reports itself offline. Default true. */
  waitWhileOffline?: boolean;
  /** Replace the rule deciding what is worth Retrying. */
  classify?: Classifier;
  /** Parts signed per `signParts` call. Default 4x concurrency, or 1x with checksums. */
  urlWindow?: number;
  /** S3's limits, overridden only for an S3-compatible store whose limits differ. */
  limits?: Partial<S3Limits>;
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
  /**
   * Where Upload Records are kept, so an Upload survives a reload.
   *
   * Defaults to IndexedDB in the browser and to nothing outside one. Pass
   * `null` to keep no Records, or a scoped store to keep one person's Uploads
   * out of the next person's reach.
   */
  store?: RecordStore | null;
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
