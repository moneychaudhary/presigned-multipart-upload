// @vitest-environment happy-dom
import { act, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  createUploader,
  createMemoryStore,
  resumeUploader,
  httpTransport,
  listResumable,
  PROVIDERS,
} from "../src/index.js";
import { useUploader } from "../src/react.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform, fakeHandle } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("httpTransport", () => {
  it("posts to the three conventional endpoints", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      return jsonResponse({ key: "k", uploadId: "u", urls: ["a", "b"] });
    });

    const transport = httpTransport({ baseUrl: "/api/uploads", fetch: fetchImpl as never });

    await transport.open(
      { name: "a.mov", size: 10, type: "video/quicktime", lastModified: 1 },
      { partCount: 2, partSize: 5, resumeFrom: undefined, signal: new AbortController().signal },
    );
    await transport.complete({ key: "k", uploadId: "u", parts: [] });
    await transport.abort({ key: "k", uploadId: "u" });

    expect(seen).toEqual(["/api/uploads", "/api/uploads/complete", "/api/uploads/abort"]);
  });

  it("supplies no signParts unless a sign path is configured", () => {
    const plain = httpTransport({ baseUrl: "/api/uploads", fetch: (() => {}) as never });
    const signing = httpTransport({
      baseUrl: "/api/uploads",
      paths: { sign: "/sign" },
      fetch: (() => {}) as never,
    });

    expect(plain.signParts).toBeUndefined();
    expect(signing.signParts).toBeTypeOf("function");
  });

  it("asks the sign endpoint for the named Parts and keys the answer by number", async () => {
    let body: unknown;
    const transport = httpTransport({
      baseUrl: "/api/uploads",
      paths: { sign: "/sign" },
      fetch: (async (_url: unknown, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return jsonResponse({ urls: { "7": "https://bucket/7", "8": "https://bucket/8" } });
      }) as never,
    });

    const urls = await transport.signParts!({
      key: "k",
      uploadId: "u",
      partNumbers: [7, 8],
      signal: new AbortController().signal,
    });

    expect(body).toEqual({ key: "k", uploadId: "u", partNumbers: [7, 8] });
    expect(urls).toEqual({ 7: "https://bucket/7", 8: "https://bucket/8" });
  });

  it("stops requiring urls from Opening once it can sign them itself", async () => {
    const transport = httpTransport({
      baseUrl: "/api/uploads",
      paths: { sign: "/sign" },
      fetch: (async () => jsonResponse({ key: "k", uploadId: "u" })) as never,
    });

    const opened = await transport.open(
      { name: "a.mov", size: 10, type: "video/quicktime", lastModified: 1 },
      { partCount: 2, partSize: 5, resumeFrom: undefined, signal: new AbortController().signal },
    );

    expect(opened).toEqual({ key: "k", uploadId: "u", urls: undefined });
  });

  it("treats a non-2xx as a failure, which bare fetch does not", async () => {
    const transport = httpTransport({
      baseUrl: "/api/uploads",
      fetch: (async () => jsonResponse({ error: "nope" }, 500)) as never,
    });

    await expect(transport.complete({ key: "k", uploadId: "u", parts: [] })).rejects.toThrow(
      /500/,
    );
  });

  it("rejects a response missing the fields it must return", async () => {
    const transport = httpTransport({
      baseUrl: "/api/uploads",
      fetch: (async () => jsonResponse({ oops: true })) as never,
    });

    await expect(
      transport.open(
        { name: "a.mov", size: 10, type: "", lastModified: 1 },
        { partCount: 1, partSize: 5, resumeFrom: undefined, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: "TRANSPORT_OPEN_FAILED" });
  });

  it("passes the abort signal through, so cancelling mid-open aborts", async () => {
    let received: AbortSignal | null = null;
    const transport = httpTransport({
      baseUrl: "/api/uploads",
      fetch: (async (_url: unknown, init: RequestInit) => {
        received = init.signal ?? null;
        return jsonResponse({ key: "k", uploadId: "u", urls: ["a"] });
      }) as never,
    });

    const controller = new AbortController();
    await transport.open(
      { name: "a.mov", size: 10, type: "", lastModified: 1 },
      { partCount: 1, partSize: 5, resumeFrom: undefined, signal: controller.signal },
    );

    expect(received).toBe(controller.signal);
  });

  it("calls a headers function per request, so a fresh token is used", async () => {
    let calls = 0;
    const transport = httpTransport({
      baseUrl: "/api/uploads",
      headers: () => {
        calls += 1;
        return { Authorization: `Bearer token-${calls}` };
      },
      fetch: (async () => jsonResponse({ ok: true })) as never,
    });

    await transport.abort({ key: "k", uploadId: "u" });
    await transport.abort({ key: "k", uploadId: "u" });

    expect(calls).toBe(2);
  });
});

describe("provider limits", () => {
  it("defaults to S3's numbers", async () => {
    const batch = createUploader({
      files: [makeFile(3 * KB)],
      transport: createFakeTransport(),
      platform: createFakePlatform(),
    });

    // 3 KB is under S3's 5 MiB floor, but a lone final Part is exempt.
    expect((await batch.start()).status).toBe("succeeded");
  });

  it("accepts a named provider", async () => {
    const batch = createUploader({
      files: [makeFile(3 * KB)],
      transport: createFakeTransport(),
      platform: createFakePlatform(),
      provider: "r2",
    });

    expect((await batch.start()).status).toBe("succeeded");
  });

  it("rejects a Part size below the provider's floor", async () => {
    const batch = createUploader({
      files: [makeFile(30 * KB)],
      transport: createFakeTransport(),
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: "s3",
    });

    expect((await batch.start()).uploads[0]!.error?.code).toBe("INVALID_PART_SIZE");
  });

  it("exposes the presets", () => {
    expect(PROVIDERS.s3.minPartSize).toBe(5 * 1024 * 1024);
    expect(PROVIDERS.s3.maxParts).toBe(10_000);
  });
});

describe("file(), for the common case of one file", () => {
  it("returns the sole Upload", async () => {
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport: createFakeTransport(),
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    await batch.start();

    expect(batch.getSnapshot().file?.progress.percent).toBe(100);
    expect(batch.getSnapshot().file?.file.name).toBe("clip.mov");
  });

  it("is null when the Batch holds more than one", async () => {
    const batch = createUploader({
      files: [makeFile(25 * KB, "a.mov"), makeFile(25 * KB, "b.mov")],
      transport: createFakeTransport(),
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    expect(batch.getSnapshot().file).toBeNull();
  });
});

describe("useUploader", () => {
  it("holds one Batch across renders and Opens exactly once", async () => {
    const transport = createFakeTransport();
    const controller = createUploader({
      files: [makeFile(25 * KB)],
      transport,
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    let seen: ReturnType<typeof useUploader> | null = null;

    const View = (): React.ReactElement => {
      seen = useUploader(controller);
      return React.createElement("div", null, seen.snapshot.status);
    };

    const { rerender } = render(React.createElement(View));
    const first = seen!.uploader;

    rerender(React.createElement(View));
    expect(seen!.uploader).toBe(first);

    await act(async () => {
      await seen!.start();
    });

    expect(screen.getByText("succeeded")).toBeTruthy();
    expect(transport.state.opens).toHaveLength(1);
  });

  it("exposes the sole file directly", async () => {
    const controller = createUploader({
      files: [makeFile(25 * KB)],
      transport: createFakeTransport(),
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });
    let seen: ReturnType<typeof useUploader> | null = null;

    const View = (): React.ReactElement => {
      seen = useUploader(controller);
      return React.createElement("div");
    };

    render(React.createElement(View));
    await act(async () => {
      await seen!.start();
    });

    expect(seen!.file?.status).toBe("succeeded");
  });

  it("still accepts an existing controller", () => {
    const controller = createUploader({
      files: [makeFile(25 * KB)],
      transport: createFakeTransport(),
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const View = (): React.ReactElement => {
      const { uploader } = useUploader(controller);
      expect(uploader).toBe(controller);
      return React.createElement("div");
    };

    render(React.createElement(View));
  });
});

describe('resume: "all"', () => {
  const interrupted = async (store: ReturnType<typeof createMemoryStore>) => {
    const file = makeFile(50 * KB);
    const batch = createUploader({
      files: [{ file, handle: fakeHandle(file) }],
      transport: createFakeTransport(),
      platform: createFakePlatform({
        script: ({ partNumber }) => (partNumber >= 3 ? { kind: "network" } : { kind: "ok" }),
        handlesSupported: true,
      }),
      store,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      maxRetries: 0,
      concurrency: 1,
    });
    await batch.start();
  };

  it("picks up everything recoverable without asking the user", async () => {
    const store = createMemoryStore();
    await interrupted(store);

    const batch = await resumeUploader({
      store,
      resume: "all",
      transport: createFakeTransport(),
      platform: createFakePlatform({ handlesSupported: true }),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    expect((await batch.resume()).uploads[0]!.status).toBe("succeeded");
  });

  it("skips Records that would need the file re-selected", async () => {
    const store = createMemoryStore();
    await interrupted(store);

    // A browser with no handle support cannot recover the bytes unaided, so
    // there is nothing to take up without involving the application.
    const platform = createFakePlatform({ handlesSupported: false });
    const batch = await resumeUploader({
      store,
      resume: "all",
      transport: createFakeTransport(),
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    expect(batch.getSnapshot().uploads).toHaveLength(0);
    expect(await listResumable({ store, platform })).toHaveLength(1);
  });
});
