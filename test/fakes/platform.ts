import {
  abortFailure,
  httpFailure,
  networkFailure,
  timeoutFailure,
} from "../../src/platform/failures.js";
import type { Platform, SendPartArgs, SendPartResult } from "../../src/index.js";

/** What a scripted send should do, chosen per part number and attempt. */
export type ScriptedOutcome =
  | { kind: "ok"; eTag?: string }
  /** Reject as a connection failure — no response ever arrived. */
  | { kind: "network" }
  /** Reject as a per-Attempt timeout. */
  | { kind: "timeout" }
  /** Respond with a non-2xx status. */
  | { kind: "status"; status: number }
  /** Respond 2xx but with no readable ETag (the CORS misconfiguration). */
  | { kind: "no-etag" }
  /** Never settle until the signal aborts, or until released by the test. */
  | { kind: "hang" };

export interface SendCall {
  uploadId: string;
  partNumber: number;
  attempt: number;
  url: string;
  size: number;
  contentType: string | undefined;
  /** The per-Attempt deadline the Core asked for; 0 when disabled. */
  timeoutMs: number;
}

export type Script = (call: SendCall) => ScriptedOutcome;

export interface FakePlatformState {
  /** Every send that was started, in order. */
  calls: SendCall[];
  /** Highest number of sends in flight simultaneously. */
  peakInFlight: number;
  /** Every delay the Core asked to sleep for, in order. */
  sleeps: number[];
}

export interface FakePlatform extends Platform {
  state: FakePlatformState;
  goOffline: () => void;
  goOnline: () => void;
  /** Settle one send that is parked in "hang". */
  releaseHung: (uploadId: string, partNumber: number, outcome: ScriptedOutcome) => void;
}

export interface FakePlatformOptions {
  script?: Script;
  /** Sequence the jitter source returns, cycled. Defaults to a constant 0.5. */
  randomValues?: number[];
  online?: boolean;
  /** Whether this fake browser can hold a durable File Handle at all. */
  handlesSupported?: boolean;
  /** Whether re-asking for read access succeeds. Defaults to true. */
  permissionGranted?: boolean;
  /** Fixed value for now(), so Record staleness is assertable. */
  now?: number;
}

/** A stand-in for a FileSystemFileHandle: something that can give back a File. */
export const fakeHandle = (file: File): { file: File } => ({ file });

const abortError = (): Error => abortFailure("aborted");

/**
 * A Platform whose every interaction with the outside world is scripted.
 *
 * Sleeps resolve immediately but are recorded, so a backoff ladder is asserted
 * without any test waiting on real time.
 */
export const createFakePlatform = (options: FakePlatformOptions = {}): FakePlatform => {
  const script: Script = options.script ?? (() => ({ kind: "ok" }));
  const randomValues = options.randomValues ?? [0.5];

  const state: FakePlatformState = { calls: [], peakInFlight: 0, sleeps: [] };
  const attemptsByPart = new Map<string, number>();
  const hung = new Map<string, (outcome: ScriptedOutcome) => void>();
  const onlineListeners = new Set<() => void>();

  let nextId = 0;
  let inFlight = 0;
  let online = options.online ?? true;
  let randomIndex = 0;

  const settleOutcome = (partNumber: number, outcome: ScriptedOutcome): SendPartResult => {
    switch (outcome.kind) {
      case "ok":
        return { eTag: outcome.eTag ?? `"etag-${partNumber}"` };
      case "no-etag":
        return { eTag: null };
      // Built from the same definitions the browser Platform uses, so the fake
      // cannot drift into disagreeing with it about what the Classifier reads.
      case "network":
        throw networkFailure(partNumber);
      case "timeout":
        throw timeoutFailure(partNumber, 0);
      case "status":
        throw httpFailure(partNumber, outcome.status);
      default:
        throw new Error(
          `releaseHung was given ${JSON.stringify(outcome)}; a hung send must be settled with a real outcome`,
        );
    }
  };

  const sendPart = async (args: SendPartArgs): Promise<SendPartResult> => {
    // Part numbers repeat across Uploads, so a Batch-wide fake must key on both
    // or one file's attempt counter bleeds into another's.
    const key = `${args.uploadId}:${args.partNumber}`;
    const attempt = (attemptsByPart.get(key) ?? 0) + 1;
    attemptsByPart.set(key, attempt);

    const call: SendCall = {
      uploadId: args.uploadId,
      partNumber: args.partNumber,
      attempt,
      url: args.url,
      size: args.body.size,
      contentType: args.contentType,
      timeoutMs: args.timeoutMs,
    };
    state.calls.push(call);

    inFlight += 1;
    state.peakInFlight = Math.max(state.peakInFlight, inFlight);

    try {
      if (args.signal.aborted) throw abortError();

      // Yield before settling. A real send always crosses at least one turn of
      // the event loop, and without that every outcome but "hang" settles
      // synchronously — which would make peakInFlight read 1 at any
      // concurrency, and the Connection Budget unobservable.
      await Promise.resolve();

      let outcome = script(call);

      if (outcome.kind === "hang") {
        outcome = await new Promise<ScriptedOutcome>((resolve, reject) => {
          hung.set(key, resolve);
          args.signal.addEventListener(
            "abort",
            () => {
              hung.delete(key);
              reject(abortError());
            },
            { once: true },
          );
        });
      }

      // Report the whole Part as transferred before settling, mirroring a real
      // upload's final progress event.
      args.onProgress?.(args.body.size);

      return settleOutcome(args.partNumber, outcome);
    } finally {
      inFlight -= 1;
    }
  };

  return {
    state,
    sendPart,
    newId: () => {
      nextId += 1;
      return `upload-${nextId}`;
    },
    now: () => options.now ?? 0,
    // Resolves rather than rejects on abort, which is the obligation the
    // Platform interface states — a rejecting sleep settles a Pause as a
    // failure.
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
    },
    random: () => {
      const value = randomValues[randomIndex % randomValues.length]!;
      randomIndex += 1;
      return value;
    },
    isOnline: () => online,
    onOnline: (listener: () => void) => {
      onlineListeners.add(listener);
      return () => {
        onlineListeners.delete(listener);
      };
    },
    files: {
      isHandleSupported: () => options.handlesSupported ?? false,
      requestPermission: async () => options.permissionGranted ?? true,
      readFile: async (handle) => {
        const target = handle as { file?: File };
        if (!target?.file) throw new Error("fake handle holds no file");
        return target.file;
      },
    },
    goOffline: () => {
      online = false;
    },
    goOnline: () => {
      online = true;
      for (const listener of [...onlineListeners]) listener();
    },
    releaseHung: (uploadId, partNumber, outcome) => {
      const key = `${uploadId}:${partNumber}`;
      const resolve = hung.get(key);
      if (!resolve) throw new Error(`${key} is not hung`);
      hung.delete(key);
      resolve(outcome);
    },
  };
};
