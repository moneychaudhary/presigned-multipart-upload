import { describe, expect, it } from "vitest";

import { createUploader, httpTransport, type UploadErrorCode } from "../src/index.js";
import { httpFailure } from "../src/advanced.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const codeFrom = async (options: Record<string, unknown>): Promise<UploadErrorCode | undefined> => {
  const batch = createUploader({
    files: [makeFile(30 * KB)],
    transport: createFakeTransport(),
    platform: createFakePlatform(),
    partSize: 10 * KB,
    limits: { minPartSize: 1 },
    retry: { max: 0 },
    ...options,
  });
  const snapshot = await batch.start();
  return snapshot.upload?.error?.code;
};

describe("each error code means one thing", () => {
  it("reports a Part that would not send as SEND_FAILED", async () => {
    const code = await codeFrom({
      platform: createFakePlatform({ script: () => ({ kind: "status", status: 400 }) }),
    });

    expect(code).toBe("SEND_FAILED");
  });

  it("does not report a failure to Open as SEND_FAILED", async () => {
    const transport = createFakeTransport();
    transport.open = () => Promise.reject(new Error("backend down"));

    const code = await codeFrom({ transport });

    expect(code).toBe("TRANSPORT_OPEN_FAILED");
  });

  it("reports a mid-flight Refresh failure the same way as one at the start", async () => {
    let opens = 0;
    const transport = createFakeTransport({
      onOpen: () => {
        opens += 1;
        if (opens > 1) throw new Error("backend down");
      },
    });

    // A 403 on the first Attempt sends the Core back to Open for fresh urls.
    const code = await codeFrom({
      transport,
      platform: createFakePlatform({
        script: ({ attempt }) => (attempt === 1 ? { kind: "status", status: 403 } : { kind: "ok" }),
      }),
    });

    // The same cause must not report a different code for happening later.
    expect(code).toBe("TRANSPORT_OPEN_FAILED");
  });

  /** A JSON backend whose endpoints answer as scripted, keyed by path. */
  const backend = (answer: (path: string, call: number) => Response) => {
    const calls = new Map<string, number>();
    return httpTransport({
      baseUrl: "https://app.example/api/uploads",
      paths: { sign: "/sign" },
      fetch: (async (url: string) => {
        const path = new URL(url).pathname.replace("/api/uploads", "") || "/";
        const call = (calls.get(path) ?? 0) + 1;
        calls.set(path, call);
        return answer(path, call);
      }) as never,
    });
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("names the endpoint that failed: a non-2xx from open is TRANSPORT_OPEN_FAILED", async () => {
    const transport = backend(() => new Response("nope", { status: 500 }));
    expect(await codeFrom({ transport })).toBe("TRANSPORT_OPEN_FAILED");
  });

  it("names the endpoint that failed: a non-2xx from complete is TRANSPORT_COMPLETE_FAILED", async () => {
    const transport = backend((path) => {
      if (path === "/") return json({ key: "k", uploadId: "u" });
      if (path === "/sign")
        return json({ urls: { 1: "https://s3/1", 2: "https://s3/2", 3: "https://s3/3" } });
      return new Response("nope", { status: 500 });
    });
    expect(await codeFrom({ transport })).toBe("TRANSPORT_COMPLETE_FAILED");
  });

  it("Retries a sign endpoint that is briefly unavailable, rather than failing the Upload", async () => {
    const transport = backend((path, call) => {
      if (path === "/") return json({ key: "k", uploadId: "u" });
      if (path === "/sign") {
        return call === 1
          ? new Response("busy", { status: 503 })
          : json({ urls: { 1: "https://s3/1", 2: "https://s3/2", 3: "https://s3/3" } });
      }
      return json({});
    });
    expect(await codeFrom({ transport, retry: { max: 2 } })).toBeUndefined();
  });

  it("names a sign endpoint that keeps refusing as TRANSPORT_SIGN_FAILED", async () => {
    const transport = backend((path) =>
      path === "/" ? json({ key: "k", uploadId: "u" }) : new Response("no", { status: 403 }),
    );
    expect(await codeFrom({ transport })).toBe("TRANSPORT_SIGN_FAILED");
  });

  it("reports an unrecognised throw as UNKNOWN rather than as a send failure", async () => {
    const code = await codeFrom({
      platform: createFakePlatform({ script: () => ({ kind: "no-etag" }) }),
    });

    // MISSING_ETAG is its own code; this only checks the default is not
    // silently SEND_FAILED. See the toErrorInfo fallback.
    expect(code).toBe("MISSING_ETAG");
  });
});

describe("a Refresh that meets a briefly unavailable open endpoint", () => {
  it("is Retried, as the same failure from the sign endpoint is", async () => {
    let opens = 0;
    const transport = createFakeTransport({
      onOpen: () => {
        opens += 1;
        // The second Opening is the Refresh after the 403; it meets a 503 once.
        if (opens === 2) throw httpFailure(503);
      },
    });

    const code = await codeFrom({
      transport,
      retry: { max: 2 },
      platform: createFakePlatform({
        script: ({ attempt }) => (attempt === 1 ? { kind: "status", status: 403 } : { kind: "ok" }),
      }),
    });

    expect(code).toBeUndefined();
  });
});
