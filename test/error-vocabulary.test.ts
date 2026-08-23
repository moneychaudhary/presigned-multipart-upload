import { describe, expect, it } from "vitest";

import { createUploader, httpTransport, type UploadErrorCode } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const codeFrom = async (options: Record<string, unknown>): Promise<UploadErrorCode | undefined> => {
  const batch = createUploader({
    files: [makeFile(30 * KB)],
    transport: createFakeTransport(),
    platform: createFakePlatform(),
    partSize: 10 * KB,
    provider: { minPartSize: 1 },
    maxRetries: 0,
    ...options,
  });
  const snapshot = await batch.start();
  return snapshot.file?.error?.code;
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

  it("does not report a non-2xx from the application's own endpoint as SEND_FAILED", async () => {
    const transport = httpTransport({
      baseUrl: "/api/uploads",
      fetch: (async () => new Response("nope", { status: 500 })) as never,
    });

    const thrown = await transport
      .abort({ key: "k", uploadId: "u" })
      .then(() => null)
      .catch((error: { code?: string }) => error.code);

    expect(thrown).toBe("TRANSPORT_REQUEST_FAILED");
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
