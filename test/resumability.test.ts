import { describe, expect, it } from "vitest";

import { createUploader } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const build = (extra = {}) => {
  const transport = createFakeTransport();
  return {
    transport,
    batch: createUploader({
      files: [makeFile(30 * KB)],
      transport,
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      ...extra,
    }),
  };
};

describe("what counts as resumable", () => {
  it("resumes an Upload paused before it ever ran", async () => {
    const { batch, transport } = build();

    await batch.pause();
    expect(batch.getSnapshot().file?.resumable).toBe(true);

    const snapshot = await batch.resume();

    // CONTEXT.md: "A Paused Upload can be Resumed." Parts had not been planned
    // yet, which used to make this a silent no-op.
    expect(snapshot.status).toBe("succeeded");
    expect(transport.state.completes).toHaveLength(1);
  });

  it("does not call an Upload that has not started resumable", () => {
    const { batch } = build();

    expect(batch.getSnapshot().file?.resumable).toBe(false);
  });

  it("does not call a succeeded Upload resumable", async () => {
    const { batch } = build();

    const snapshot = await batch.start();

    expect(snapshot.file?.resumable).toBe(false);
  });

  it("does not call a cancelled Upload resumable", async () => {
    const { batch } = build();

    await batch.cancel();

    expect(batch.getSnapshot().file?.resumable).toBe(false);
  });
});

describe("an Upload recovered from a previous page session", () => {
  it("is presented as paused rather than failed, with no error to show", async () => {
    const { createMemoryStore, resumeUploader } = await import("../src/index.js");
    const { fakeHandle } = await import("./fakes/platform.js");

    const store = createMemoryStore();
    const file = makeFile(30 * KB);
    const platform = createFakePlatform({
      handlesSupported: true,
      script: ({ partNumber }) => (partNumber >= 2 ? { kind: "network" } : { kind: "ok" }),
    });

    await createUploader({
      files: [{ file, handle: fakeHandle(file) }],
      transport: createFakeTransport(),
      platform,
      store,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      maxRetries: 0,
      concurrency: 1,
    }).start();

    const resumed = await resumeUploader({
      store,
      transport: createFakeTransport(),
      platform: createFakePlatform({ handlesSupported: true }),
      resume: "all",
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

    const snapshot = resumed.getSnapshot();

    // It was interrupted, not broken. Showing NOT_RESUMABLE on something the
    // adjacent field calls resumable is a contradiction an adopter renders.
    expect(snapshot.file?.status).toBe("paused");
    expect(snapshot.file?.error).toBeNull();
    expect(snapshot.file?.resumable).toBe(true);
  });
});
