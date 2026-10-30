import type {
  CompletedPart,
  FileDescriptor,
  OpenContext,
  OpenSingleContext,
  OpenSingleResult,
  OpenResult,
  SignPartsArgs,
  Transport,
} from "../../src/index.js";

/**
 * The storage provider's multipart id, deliberately prefixed so it cannot be
 * mistaken for the library's own Upload id in an assertion. The two used to be
 * `upload-0` and `upload-1`, adjacent and off by one.
 */
export interface OpenRecord {
  fileName: string;
  partCount: number;
  partSize: number;
  resumeFrom: { key: string; uploadId: string } | undefined;
  checksumAlgorithm: string | undefined;
}

export interface SingleRecord {
  fileName: string;
  checksumCRC32: string | undefined;
}

export interface CompleteRecord {
  key: string;
  uploadId: string;
  parts: CompletedPart[];
}

export interface SignRecord {
  partNumbers: number[];
  checksumsCRC32: Record<number, string> | undefined;
  /** Which Refresh this signing belongs to; the nth call to signParts. */
  index: number;
}

export interface FakeTransportState {
  opens: OpenRecord[];
  /** Every signParts call, in order. Empty unless `signsParts` was asked for. */
  signs: SignRecord[];
  /** Every openSingle call, in order. Empty unless `opensSingle` was asked for. */
  singles: SingleRecord[];
  completes: CompleteRecord[];
  aborts: { key: string; uploadId: string }[];
}

export interface FakeTransport extends Transport {
  state: FakeTransportState;
}

export interface FakeTransportOptions {
  onOpen?: (ctx: OpenContext, openIndex: number) => void | Promise<void>;
  onComplete?: (record: CompleteRecord) => void | Promise<void>;
  onAbort?: (args: { key: string; uploadId: string }) => void | Promise<void>;
  /** Return fewer urls than Parts, to exercise the invalid-Transport path. */
  urlCount?: (partCount: number) => number;
  /**
   * Supply `signParts`, so Opening mints no urls and the library asks for them
   * a window at a time. This is the large-Upload Transport shape.
   */
  signsParts?: boolean;
  /** Omit these Part numbers from every signing, to exercise a broken backend. */
  refuseToSign?: number[];
  /** Called before each signing; throw to model a signing endpoint that fails. */
  onSign?: (args: SignPartsArgs, signIndex: number) => void | Promise<void>;
  /**
   * Whether a pending request rejects when its signal aborts, as `fetch` does.
   * Default true. Turn it off to model a hand-written Transport that ignores
   * the signal and lets the request finish anyway.
   */
  honoursSignal?: boolean;
  /** Supply `openSingle`, so a file that fits in one Part goes as one PUT. */
  opensSingle?: boolean;
  /** Called before each openSingle; throw to model a failing endpoint. */
  onOpenSingle?: (ctx: OpenSingleContext, index: number) => void | Promise<void>;
}

const abortError = (): Error =>
  Object.assign(new Error("The request was aborted"), { name: "AbortError" });

/** Wait for `work`, unless `signal` aborts first — the contract `fetch` keeps. */
const unlessAborted = async <T>(
  work: T | Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> => {
  if (signal === undefined) return work;
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(work).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

export const createFakeTransport = (options: FakeTransportOptions = {}): FakeTransport => {
  const state: FakeTransportState = {
    opens: [],
    signs: [],
    singles: [],
    completes: [],
    aborts: [],
  };
  let openIndex = 0;

  // The Opening index is in the url, so a test can prove which Opening or
  // signing a Part was sent on — that is how url freshness is asserted.
  const prefixFor = (index: number): string => `https://bucket.example/part-open${index}`;

  const open = async (file: { name: string }, ctx: OpenContext): Promise<OpenResult> => {
    const index = openIndex;
    openIndex += 1;

    state.opens.push({
      fileName: file.name,
      partCount: ctx.partCount,
      partSize: ctx.partSize,
      resumeFrom: ctx.resumeFrom,
      checksumAlgorithm: ctx.checksumAlgorithm,
    });

    const honours = options.honoursSignal ?? true;
    await unlessAborted(options.onOpen?.(ctx, index), honours ? ctx.signal : undefined);

    // A Transport that signs on demand mints nothing here — Opening settles
    // only which Upload this is.
    if (options.signsParts) {
      return {
        key: ctx.resumeFrom?.key ?? `uploads/${file.name}`,
        uploadId: ctx.resumeFrom?.uploadId ?? `s3-upload-${index}`,
      };
    }

    const count = options.urlCount ? options.urlCount(ctx.partCount) : ctx.partCount;
    return {
      key: ctx.resumeFrom?.key ?? `uploads/${file.name}`,
      uploadId: ctx.resumeFrom?.uploadId ?? `s3-upload-${index}`,
      urls: Array.from({ length: count }, (_, i) => `${prefixFor(index)}-${i + 1}`),
    };
  };

  let signIndex = 0;

  const signParts = async (args: SignPartsArgs): Promise<Record<number, string>> => {
    const index = signIndex;
    signIndex += 1;
    state.signs.push({
      partNumbers: [...args.partNumbers],
      checksumsCRC32: args.checksumsCRC32,
      index,
    });
    await unlessAborted(
      options.onSign?.(args, index),
      (options.honoursSignal ?? true) ? args.signal : undefined,
    );

    const refused = new Set(options.refuseToSign ?? []);
    const minted: Record<number, string> = {};
    for (const partNumber of args.partNumbers) {
      if (refused.has(partNumber)) continue;
      minted[partNumber] = `${prefixFor(index)}-${partNumber}`;
    }
    return minted;
  };

  const complete = async (args: {
    key: string;
    uploadId: string;
    parts: CompletedPart[];
  }): Promise<unknown> => {
    const record: CompleteRecord = { key: args.key, uploadId: args.uploadId, parts: args.parts };
    state.completes.push(record);
    await options.onComplete?.(record);
    return { location: `https://bucket.example/${args.key}` };
  };

  const abort = async (args: { key: string; uploadId: string }): Promise<unknown> => {
    state.aborts.push({ key: args.key, uploadId: args.uploadId });
    await options.onAbort?.(args);
    return undefined;
  };

  let singleIndex = 0;

  const openSingle = async (
    file: FileDescriptor,
    ctx: OpenSingleContext,
  ): Promise<OpenSingleResult> => {
    const index = singleIndex;
    singleIndex += 1;
    state.singles.push({ fileName: file.name, checksumCRC32: ctx.checksumCRC32 });
    await unlessAborted(
      options.onOpenSingle?.(ctx, index),
      (options.honoursSignal ?? true) ? ctx.signal : undefined,
    );
    return { key: `objects/${file.name}`, url: `https://bucket.example/single${index}` };
  };

  return {
    state,
    open,
    complete,
    abort,
    ...(options.signsParts ? { signParts } : {}),
    ...(options.opensSingle ? { openSingle } : {}),
  };
};
