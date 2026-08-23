import { describe, expect, it } from "vitest";

import { createUploader } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const build = (extra = {}) => {
  const platform = createFakePlatform();
  const transport = createFakeTransport();
  return {
    platform,
    transport,
    batch: createUploader({
      files: [makeFile(30 * KB)],
      transport,
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      ...extra,
    }),
  };
};

describe("starting a Batch that has already run", () => {
  it("does not Open or finalise a second time when started again", async () => {
    const { batch, transport, platform } = build();

    await batch.start();
    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(transport.state.opens).toHaveLength(1);
    expect(transport.state.completes).toHaveLength(1);
    expect(platform.state.calls).toHaveLength(3);
  });

  it("does not resurrect a cancelled Upload", async () => {
    const { batch, transport } = build();

    await batch.cancel();
    const snapshot = await batch.start();

    // Cancel is terminal: the multipart upload is already torn down at the
    // provider, so re-sending Parts would write into an upload that is gone.
    expect(snapshot.status).toBe("cancelled");
    expect(transport.state.completes).toHaveLength(0);
  });

  it("does not send every Part twice when started concurrently", async () => {
    const { batch, transport, platform } = build();

    const [first, second] = await Promise.all([batch.start(), batch.start()]);

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(platform.state.calls).toHaveLength(3);
    expect(transport.state.opens).toHaveLength(1);
  });

  it("still starts an Upload that was paused before it ever ran", async () => {
    const { batch, transport } = build();

    await batch.pause();
    const snapshot = await batch.start();

    expect(snapshot.status).toBe("succeeded");
    expect(transport.state.completes).toHaveLength(1);
  });
});
