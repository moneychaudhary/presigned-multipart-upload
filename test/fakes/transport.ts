import type { CompletedPart, OpenContext, OpenResult, Transport } from "../../src/index.js";

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

export interface FakeTransportState {
  opens: OpenRecord[];
  completes: CompleteRecord[];
  aborts: { key: string; uploadId: string }[];
  /** Urls handed out by the most recent Opening, in Part order. */
  lastUrls: string[];
}

export interface FakeTransport extends Transport {
  state: FakeTransportState;
}

export interface FakeTransportOptions {
  /** Prefix for generated urls; varies per Opening so freshness is provable. */
  urlPrefix?: string | ((openIndex: number) => string);
  onOpen?: (ctx: OpenContext, openIndex: number) => void | Promise<void>;
  onComplete?: (record: CompleteRecord) => void | Promise<void>;
  onAbort?: (args: { key: string; uploadId: string }) => void | Promise<void>;
  /** Return fewer urls than Parts, to exercise the invalid-Transport path. */
  urlCount?: (partCount: number) => number;
}

export const createFakeTransport = (options: FakeTransportOptions = {}): FakeTransport => {
  const state: FakeTransportState = { opens: [], completes: [], aborts: [], lastUrls: [] };
  let openIndex = 0;

  const prefixFor = (index: number): string => {
    const prefix = options.urlPrefix ?? "https://bucket.example/part";
    return typeof prefix === "function" ? prefix(index) : `${prefix}-open${index}`;
  };

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

    const count = options.urlCount ? options.urlCount(ctx.partCount) : ctx.partCount;
    state.lastUrls = Array.from({ length: count }, (_, i) => `${prefixFor(index)}-${i + 1}`);

    return {
      key: ctx.resumeFrom?.key ?? `uploads/${file.name}`,
      uploadId: ctx.resumeFrom?.uploadId ?? `upload-${index}`,
      urls: state.lastUrls,
    };
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

  return { state, open, complete, abort };
};
