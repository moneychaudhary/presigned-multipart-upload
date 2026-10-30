import { describe, expect, it } from "vitest";

import { createUploader, listResumable } from "../src/index.js";
import { createMemoryStore } from "../src/advanced.js";
import type { UploaderEvents } from "../src/index.js";
import { deferred, flush } from "./fakes/async.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

/**
 * A Cancel or Pause that lands while the Upload is talking to the application's
 * own API — Opening or finalising — rather than sending Parts.
 *
 * The Transport is handed the signal, and `fetch` rejects with an AbortError
 * when it fires. That rejection is the Core's own doing and must settle as the
 * halt that caused it, never as a failure of the endpoint.
 */
describe("halting while a request to your API is in flight", () => {
  const build = (transport = createFakeTransport({ onOpen: () => new Promise(() => {}) })) => {
    const store = createMemoryStore();
    const failed: UploaderEvents["upload:failed"][] = [];
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport,
      platform: createFakePlatform(),
      store,
      partSize: 10 * KB,
      limits: { minPartSize: 1 },
    });
    batch.on("upload:failed", (payload) => failed.push(payload));
    return { batch, transport, store, failed };
  };

  it("settles a Cancel during Opening as cancelled, not failed", async () => {
    const { batch, failed } = build();

    const run = batch.start();
    await flush();
    expect(batch.getSnapshot().uploads[0]!.status).toBe("opening");

    const snapshot = await batch.cancel();
    await run;

    expect(snapshot.uploads[0]!.status).toBe("cancelled");
    expect(snapshot.uploads[0]!.error).toBeNull();
    expect(failed).toEqual([]);
  });

  it("settles a Pause during Opening as paused, and a Resume finishes it", async () => {
    let opens = 0;
    const transport = createFakeTransport({
      // The first Opening hangs until aborted; the one after the Resume answers.
      onOpen: () => {
        opens += 1;
        return opens === 1 ? new Promise(() => {}) : undefined;
      },
    });
    const { batch, failed } = build(transport);

    const run = batch.start();
    await flush();
    const paused = await batch.pause();
    await run;

    expect(paused.uploads[0]!.status).toBe("paused");
    expect(paused.uploads[0]!.resumable).toBe(true);
    expect(failed).toEqual([]);

    const resumed = await batch.resume();
    expect(resumed.uploads[0]!.status).toBe("succeeded");
  });

  it("settles a Cancel during finalising as cancelled when finalising is aborted", async () => {
    const gate = deferred();
    const transport = createFakeTransport({
      onComplete: () => gate.promise,
    });
    const { batch, failed } = build(transport);

    const run = batch.start();
    await flush(6);
    expect(batch.getSnapshot().uploads[0]!.status).toBe("completing");

    const cancelling = batch.cancel();
    gate.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const snapshot = await cancelling;
    await run;

    expect(snapshot.uploads[0]!.status).toBe("cancelled");
    expect(failed).toEqual([]);
    expect(transport.state.aborts).toHaveLength(1);
  });

  it("keeps no Record for an Upload cancelled while Opening", async () => {
    const { batch, store } = build();

    const run = batch.start();
    await flush();
    await batch.cancel();
    await run;

    expect(await listResumable({ store })).toEqual([]);
  });
});
