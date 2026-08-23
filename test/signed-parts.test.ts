import { describe, expect, it } from "vitest";

import { createUploader, type UploadError } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform, type Script } from "./fakes/platform.js";
import { createFakeTransport, type FakeTransportOptions } from "./fakes/transport.js";

/** A 100 KB file in 10 KB Parts: ten Parts, enough to see a window move. */
const build = (script?: Script, extra = {}, transportOptions: FakeTransportOptions = {}) => {
  const platform = createFakePlatform(script ? { script } : {});
  const transport = createFakeTransport({ signsParts: true, ...transportOptions });
  return {
    platform,
    transport,
    batch: createUploader({
      files: [makeFile(100 * KB)],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      ...extra,
    }),
  };
};

const signedNumbers = (signs: { partNumbers: number[] }[]): number[] =>
  signs.flatMap((sign) => sign.partNumbers);

describe("a Transport that signs Parts on demand", () => {
  it("uploads without the Opening minting a single url", async () => {
    const { batch, transport } = build();

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(transport.state.opens).toHaveLength(1);
    expect(transport.state.completes).toHaveLength(1);
  });

  it("signs every Part exactly once when nothing goes wrong", async () => {
    const { batch, transport } = build();

    await batch.start();

    const signed = signedNumbers(transport.state.signs).sort((a, b) => a - b);
    expect(signed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("signs a window rather than the whole Upload up front", async () => {
    const { batch, transport } = build(undefined, { concurrency: 1, urlWindow: 3 });

    await batch.start();

    // Ten Parts, three at a time: nobody signed url ten before Part one landed.
    expect(transport.state.signs[0]!.partNumbers).toEqual([1, 2, 3]);
    expect(transport.state.signs.length).toBeGreaterThan(1);
  });

  it("trades sign requests for window size, which is the knob the README sells", async () => {
    // Ten Parts. The window is the batch size, so a wider one is fewer calls —
    // and one wide enough for the whole Upload is a single call.
    const narrow = build(undefined, { concurrency: 1, urlWindow: 2 });
    await narrow.batch.start();

    const wide = build(undefined, { concurrency: 1, urlWindow: 1000 });
    await wide.batch.start();

    expect(narrow.transport.state.signs).toHaveLength(5);
    expect(wide.transport.state.signs).toHaveLength(1);
    expect(wide.transport.state.signs[0]!.partNumbers).toHaveLength(10);
  });

  it("sends each Part on the url that was signed for it", async () => {
    const { batch, platform } = build(undefined, { concurrency: 1, urlWindow: 3 });

    await batch.start();

    for (const call of platform.state.calls) {
      expect(call.url.endsWith(`-${call.partNumber}`)).toBe(true);
    }
  });

  it("re-signs rather than re-Opening when the urls expire", async () => {
    // An expiry is a property of the urls, not of the Attempt: everything the
    // first signing minted is refused, everything signed after it is honoured.
    const { batch, transport } = build(
      ({ url }) => (url.includes("open0") ? { kind: "status", status: 403 } : { kind: "ok" }),
      { concurrency: 5 },
    );

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    // The whole point: an expiry costs a signing, not a second Opening.
    expect(transport.state.opens).toHaveLength(1);
    expect(transport.state.signs.length).toBeGreaterThan(1);
  });

  it("still ends a genuine authorisation failure rather than signing forever", async () => {
    const { batch, transport } = build(() => ({ kind: "status", status: 403 }), {
      concurrency: 5,
      maxRetries: 0,
    });

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("failed");
    expect(transport.state.signs.length).toBeLessThan(10);
  });

  it("fails the Upload when the backend signs fewer Parts than it was asked for", async () => {
    const { batch } = build(undefined, { concurrency: 1, maxRetries: 0 }, { refuseToSign: [4] });

    const snapshot = await batch.start();
    const error = snapshot.uploads[0]!.error as UploadError | null;

    expect(snapshot.status).toBe("failed");
    expect(error?.code).toBe("URL_MISSING");
  });

  it("Retries a signing that fails transiently rather than failing the Upload", async () => {
    let signings = 0;
    const { batch, transport } = build(
      undefined,
      { concurrency: 1 },
      {
        onSign: () => {
          signings += 1;
          if (signings === 1) throw Object.assign(new Error("down"), { name: "NetworkError" });
        },
      },
    );

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(transport.state.signs.length).toBeGreaterThan(1);
  });

  it("ends the Upload when the signing endpoint refuses outright", async () => {
    const { batch } = build(
      undefined,
      { concurrency: 1, maxRetries: 2 },
      {
        onSign: () => {
          throw Object.assign(new Error("forbidden"), { name: "HttpError", status: 403 });
        },
      },
    );

    const snapshot = await batch.start();

    // A 403 from signing cannot be repaired by signing again.
    expect(snapshot.status).toBe("failed");
  });

  it("carries the Upload's identity into every signing", async () => {
    const { batch, transport } = build();

    await batch.start();

    expect(transport.state.opens).toHaveLength(1);
    expect(transport.state.completes[0]!.uploadId).toBe("s3-upload-0");
  });
});

describe("a Transport that mints urls at Opening", () => {
  it("is still supported, and never asks for a signing", async () => {
    const platform = createFakePlatform();
    const transport = createFakeTransport();
    const batch = createUploader({
      files: [makeFile(100 * KB)],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(transport.state.signs).toHaveLength(0);
  });

  it("is refused when it mints nothing and cannot sign either", async () => {
    const platform = createFakePlatform();
    const transport = createFakeTransport({ urlCount: () => 0 });
    const batch = createUploader({
      files: [makeFile(100 * KB)],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const snapshot = await batch.start();

    expect(snapshot.uploads[0]!.error?.code).toBe("URL_COUNT_MISMATCH");
  });
});
