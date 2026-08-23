import type {
  CompletedPart,
  OpenContext,
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
}

export interface CompleteRecord {
  key: string;
  uploadId: string;
  parts: CompletedPart[];
}

export interface SignRecord {
  partNumbers: number[];
  /** Which Refresh this signing belongs to; the nth call to signParts. */
  index: number;
}

export interface FakeTransportState {
  opens: OpenRecord[];
  /** Every signParts call, in order. Empty unless `signsParts` was asked for. */
  signs: SignRecord[];
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
}

export const createFakeTransport = (options: FakeTransportOptions = {}): FakeTransport => {
  const state: FakeTransportState = {
    opens: [],
    signs: [],
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
    });

    await options.onOpen?.(ctx, index);

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
    state.signs.push({ partNumbers: [...args.partNumbers], index });
    await options.onSign?.(args, index);

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

  return options.signsParts
    ? { state, open, complete, abort, signParts }
    : { state, open, complete, abort };
};
