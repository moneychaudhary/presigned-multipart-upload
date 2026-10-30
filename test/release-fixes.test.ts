import { describe, expect, it } from "vitest";

import { createUploader, listResumable, resumeUploader } from "../src/index.js";
import { createMemoryStore, httpFailure } from "../src/advanced.js";
import { flush } from "./fakes/async.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const base = { partSize: 10 * KB, limits: { minPartSize: 1 } };

describe("the settled event", () => {
  it("fires once, when the whole Batch has stopped — not when one Upload resumed", async () => {
    let failA = true;
    const platform = createFakePlatform({
      script: ({ id }) =>
        id === "upload-2"
          ? { kind: "hang" }
          : failA
            ? { kind: "status", status: 400 }
            : { kind: "ok" },
    });
    const batch = createUploader({
      files: [makeFile(20 * KB, "a.bin"), makeFile(20 * KB, "b.bin")],
      transport: createFakeTransport(),
      platform,
      ...base,
    });
    const settled: string[] = [];
    batch.on("uploader:settled", ({ status }) => settled.push(status));

    const run = batch.start();
    await flush();
    failA = false;
    await batch.resume("upload-1");

    // upload-2 is still hanging: the Batch has not settled.
    expect(settled).toEqual([]);
    await batch.cancel();
    await run;
    expect(settled).toHaveLength(1);
  });
});

describe("offline waiting turned off", () => {
  it("fails fast instead of spending the retry budget", async () => {
    const platform = createFakePlatform({ online: false, script: () => ({ kind: "network" }) });
    const batch = createUploader({
      files: [makeFile(10 * KB)],
      transport: createFakeTransport(),
      platform,
      ...base,
      waitWhileOffline: false,
    });

    const settled = await batch.start();

    // Offline before the first Attempt: nothing is sent, nothing is slept on.
    expect(settled.upload?.status).toBe("failed");
    expect(settled.upload?.error?.code).toBe("SEND_FAILED");
    expect(platform.state.calls).toHaveLength(0);
    expect(platform.state.sleeps).toEqual([]);
  });
});

describe("a briefly unavailable backend", () => {
  it("is retried on the first Opening, as a Part would be", async () => {
    let opens = 0;
    const transport = createFakeTransport({
      onOpen: () => {
        opens += 1;
        if (opens === 1) throw httpFailure(503);
      },
    });
    const settled = await createUploader({
      files: [makeFile(20 * KB)],
      transport,
      platform: createFakePlatform(),
      ...base,
    }).start();

    expect(settled.status).toBe("succeeded");
    expect(opens).toBe(2);
  });

  it("is retried on finalising", async () => {
    let completes = 0;
    const transport = createFakeTransport({
      onComplete: () => {
        completes += 1;
        if (completes === 1) throw httpFailure(503);
      },
    });
    const settled = await createUploader({
      files: [makeFile(20 * KB)],
      transport,
      platform: createFakePlatform(),
      ...base,
    }).start();

    expect(settled.status).toBe("succeeded");
    expect(completes).toBe(2);
  });

  it("asks a custom classifier, which can rule it fatal", async () => {
    const transport = createFakeTransport({
      onOpen: () => {
        throw httpFailure(503);
      },
    });
    const settled = await createUploader({
      files: [makeFile(20 * KB)],
      transport,
      platform: createFakePlatform(),
      ...base,
      classify: () => "fatal",
    }).start();

    expect(transport.state.opens).toHaveLength(1);
    expect(settled.upload?.error?.code).toBe("TRANSPORT_OPEN_FAILED");
  });
});

describe("checksums across a reload", () => {
  it("carry on from the Record even when the revived uploader was not told", async () => {
    const store = createMemoryStore();
    const file = makeFile(30 * KB);
    const clock = createFakePlatform({
      script: ({ partNumber }) =>
        partNumber === 3 ? { kind: "status", status: 400 } : { kind: "ok" },
    });
    await createUploader({
      files: [file],
      transport: createFakeTransport({ signsParts: true }),
      platform: clock,
      store,
      ...base,
      checksum: "CRC32",
      concurrency: 1,
    }).start();

    const [found] = await listResumable({ store, platform: createFakePlatform() });
    const transport = createFakeTransport({ signsParts: true });
    const revived = await resumeUploader({
      store,
      transport,
      platform: createFakePlatform(),
      resume: [{ id: found!.id, file }],
    });
    await revived.resume();

    const parts = transport.state.completes[0]!.parts;
    expect(parts.every((part) => typeof part.checksumCRC32 === "string")).toBe(true);
  });
});

describe("speed on a stalled transfer", () => {
  it("lapses on the periodic refresh, with nothing else changing", async () => {
    const platform = createFakePlatform({
      script: ({ partNumber }) => {
        if (partNumber > 2) return { kind: "hang" };
        platform.advance(1000);
        return { kind: "ok" };
      },
    });
    const batch = createUploader({
      files: [makeFile(50 * KB)],
      transport: createFakeTransport(),
      platform,
      ...base,
      concurrency: 1,
    });
    const seen: (number | null)[] = [];
    batch.subscribe((s) => seen.push(s.progress.bytesPerSecond));

    const run = batch.start();
    await flush();
    expect(seen.at(-1)).not.toBeNull();

    platform.advance(60_000);
    platform.tick();
    expect(seen.at(-1)).toBeNull();

    await batch.cancel();
    await run;
  });
});
