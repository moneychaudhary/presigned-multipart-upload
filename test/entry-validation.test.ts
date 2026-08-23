import { describe, expect, it } from "vitest";

import { createUploader, httpTransport, UploadError, UploadErrorCode } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakeTransport } from "./fakes/transport.js";

/**
 * What the public entrypoints do with the arguments nobody meant to pass.
 *
 * A TypeScript caller is stopped by the compiler; a JavaScript one is not, and
 * used to meet an internal TypeError with no code and a stack pointing into
 * the library. Every rejection here names what is wrong and carries a code.
 */
const thrownBy = (run: () => unknown): UploadError => {
  try {
    run();
  } catch (error) {
    if (error instanceof UploadError) return error;
    throw new Error(`expected an UploadError, got ${String(error)}`);
  }
  throw new Error("expected a throw, got none");
};

describe("createUploader, given arguments it cannot use", () => {
  const transport = createFakeTransport();

  it("refuses no options at all", () => {
    // @ts-expect-error the compiler stops this; JavaScript callers reach it.
    expect(thrownBy(() => createUploader()).code).toBe(UploadErrorCode.InvalidOptions);
  });

  it("refuses a missing transport, rather than failing later at Opening", () => {
    // @ts-expect-error deliberately omitted
    const error = thrownBy(() => createUploader({ files: [makeFile(KB)] }));
    expect(error.code).toBe(UploadErrorCode.InvalidOptions);
    expect(error.message).toMatch(/transport/i);
  });

  it("refuses a transport missing one of its three functions", () => {
    // @ts-expect-error abort omitted
    const error = thrownBy(() => createUploader({ files: [], transport: { open: async () => {}, complete: async () => {} } }));
    expect(error.code).toBe(UploadErrorCode.InvalidOptions);
    expect(error.message).toMatch(/abort/);
  });

  it("refuses a files list that is not a list", () => {
    // @ts-expect-error not an array
    const error = thrownBy(() => createUploader({ files: makeFile(KB), transport }));
    expect(error.code).toBe(UploadErrorCode.InvalidOptions);
    expect(error.message).toMatch(/files/i);
  });

  it("names the entry that is not a file, and its position", () => {
    // @ts-expect-error not a File
    const error = thrownBy(() => createUploader({ files: [makeFile(KB), { nope: 1 }], transport }));
    expect(error.code).toBe(UploadErrorCode.InvalidOptions);
    expect(error.message).toMatch(/files\[1\]/);
  });

  it("accepts both supported file shapes", () => {
    const file = makeFile(KB);
    expect(() =>
      createUploader({ files: [file, { file, handle: null }], transport, store: null }),
    ).not.toThrow();
  });
});

describe("httpTransport, given arguments it cannot use", () => {
  it("refuses a missing baseUrl", () => {
    // @ts-expect-error baseUrl is required
    const error = thrownBy(() => httpTransport({}));
    expect(error.code).toBe(UploadErrorCode.InvalidOptions);
    expect(error.message).toMatch(/baseUrl/);
  });

  it("refuses no options at all", () => {
    // @ts-expect-error options are required
    expect(thrownBy(() => httpTransport()).code).toBe(UploadErrorCode.InvalidOptions);
  });
});
