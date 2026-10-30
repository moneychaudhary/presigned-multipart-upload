import { describe, expect, it } from "vitest";

import { createUploader, httpTransport, listResumable } from "../src/index.js";
import { createMemoryStore } from "../src/advanced.js";
import { flush } from "./fakes/async.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform, type Script } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

/**
 * A file that fits in one Part costs multipart two extra round trips — open
 * and finalise — for nothing. Given a Transport that can sign a plain PUT, it
 * goes as one.
 */
const build = (size: number, script?: Script) => {
  const platform = createFakePlatform(script === undefined ? {} : { script });
  const transport = createFakeTransport({ opensSingle: true });
  const store = createMemoryStore();
  const batch = createUploader({
    files: [makeFile(size)],
    transport,
    platform,
    store,
    partSize: 10 * KB,
    limits: { minPartSize: 1 },
  });
  return { platform, transport, store, batch };
};

describe("a file that fits in one Part, with a Transport that signs single PUTs", () => {
  it("is sent as one PUT, with nothing to open or finalise", async () => {
    const { platform, transport, batch } = build(8 * KB);

    const settled = await batch.start();

    expect(settled.status).toBe("succeeded");
    expect(transport.state.singles).toHaveLength(1);
    expect(transport.state.opens).toHaveLength(0);
    expect(transport.state.completes).toHaveLength(0);
    expect(platform.state.calls.map((call) => call.url)).toEqual([
      "https://bucket.example/single0",
    ]);
  });

  it("reports the key it was written to, and no multipart id", async () => {
    const { batch } = build(8 * KB);
    const settled = await batch.start();

    expect(settled.upload?.key).toBe("objects/clip.mov");
    expect(settled.upload?.uploadId).toBeNull();
  });

  it("sends the file's Content-Type, which a plain PUT stores on the object", async () => {
    const { platform, batch } = build(8 * KB);
    await batch.start();

    expect(platform.state.calls[0]!.headers["Content-Type"]).toBe("video/quicktime");
  });

  it("does not need a readable ETag, since nothing is finalised", async () => {
    const { batch } = build(8 * KB, () => ({ kind: "no-etag" }));

    expect((await batch.start()).status).toBe("succeeded");
  });

  it("signs again when the url is refused as expired", async () => {
    const { transport, batch } = build(8 * KB, ({ attempt }) =>
      attempt === 1 ? { kind: "status", status: 403 } : { kind: "ok" },
    );

    expect((await batch.start()).status).toBe("succeeded");
    expect(transport.state.singles).toHaveLength(2);
  });

  it("has nothing to tear down when cancelled mid-send", async () => {
    const { transport, batch } = build(8 * KB, () => ({ kind: "hang" }));

    const run = batch.start();
    await flush();
    const snapshot = await batch.cancel();
    await run;

    expect(snapshot.upload?.status).toBe("cancelled");
    expect(transport.state.aborts).toHaveLength(0);
  });

  it("keeps no Record, since there is no multipart upload to take back up", async () => {
    const { store, batch } = build(8 * KB, () => ({ kind: "status", status: 400 }));

    expect((await batch.start()).status).toBe("failed");
    expect(await listResumable({ store })).toEqual([]);
  });

  it("can be Resumed after failing, by signing a fresh PUT", async () => {
    let fail = true;
    const { transport, batch } = build(8 * KB, () =>
      fail ? { kind: "status", status: 400 } : { kind: "ok" },
    );

    expect((await batch.start()).upload?.resumable).toBe(true);
    fail = false;

    expect((await batch.resume()).status).toBe("succeeded");
    expect(transport.state.singles).toHaveLength(2);
  });

  it("still uses multipart for a file of more than one Part", async () => {
    const { transport, batch } = build(25 * KB);
    await batch.start();

    expect(transport.state.singles).toHaveLength(0);
    expect(transport.state.opens).toHaveLength(1);
    expect(transport.state.completes).toHaveLength(1);
  });
});

describe("the JSON Transport's single endpoint", () => {
  it("is used when configured, and skips open and complete", async () => {
    const paths: string[] = [];
    const transport = httpTransport({
      baseUrl: "https://app.example/api/uploads",
      paths: { single: "/single" },
      fetch: (async (url: string, init: RequestInit) => {
        paths.push(new URL(url).pathname);
        expect(JSON.parse(String(init.body))).toMatchObject({ name: "clip.mov", size: 8 * KB });
        return new Response(JSON.stringify({ key: "objects/clip.mov", url: "https://s3/put" }));
      }) as never,
    });
    const platform = createFakePlatform();

    const settled = await createUploader({
      files: [makeFile(8 * KB)],
      transport,
      platform,
      partSize: 10 * KB,
      limits: { minPartSize: 1 },
    }).start();

    expect(settled.status).toBe("succeeded");
    expect(paths).toEqual(["/api/uploads/single"]);
    expect(platform.state.calls[0]!.url).toBe("https://s3/put");
  });

  it("names a malformed answer as an Opening failure", async () => {
    const transport = httpTransport({
      baseUrl: "https://app.example/api/uploads",
      paths: { single: "/single" },
      fetch: (async () => new Response(JSON.stringify({ key: "k" }))) as never,
    });

    const settled = await createUploader({
      files: [makeFile(8 * KB)],
      transport,
      platform: createFakePlatform(),
      partSize: 10 * KB,
      limits: { minPartSize: 1 },
    }).start();

    expect(settled.upload?.error?.code).toBe("TRANSPORT_OPEN_FAILED");
  });
});
