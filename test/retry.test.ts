import { describe, expect, it, vi } from "vitest";

import { createUploader, defaultClassifier } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform, type FakePlatformOptions } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const run = async (platformOptions: FakePlatformOptions, tuning = {}) => {
  const platform = createFakePlatform(platformOptions);
  const transport = createFakeTransport();
  const batch = createUploader({
    files: [makeFile(25 * KB)],
    transport,
    platform,
    partSize: 10 * KB,
    provider: { minPartSize: 1 },
    ...tuning,
  });
  const snapshot = await batch.start();
  return { snapshot, platform, transport, batch };
};

describe("Retrying a transient failure", () => {
  it("retries and then succeeds", async () => {
    const { snapshot, platform } = await run({
      script: ({ partNumber, attempt }) =>
        partNumber === 2 && attempt === 1 ? { kind: "network" } : { kind: "ok" },
    });

    expect(snapshot.status).toBe("succeeded");
    expect(platform.state.calls.filter((call) => call.partNumber === 2)).toHaveLength(2);
  });

  it("records the Attempt count per Part", async () => {
    const { snapshot } = await run({
      script: ({ partNumber, attempt }) =>
        partNumber === 2 && attempt <= 2 ? { kind: "network" } : { kind: "ok" },
    });

    const parts = snapshot.uploads[0]!.parts;
    expect(parts[0]!.attempts).toBe(1);
    expect(parts[1]!.attempts).toBe(3);
    expect(parts[2]!.attempts).toBe(1);
  });

  it("keeps the Retry budget per Part rather than shared across Parts", async () => {
    // Every Part fails once. If the budget were shared, the third would run out.
    const { snapshot } = await run({
      script: ({ attempt }) => (attempt === 1 ? { kind: "network" } : { kind: "ok" }),
    });

    expect(snapshot.status).toBe("succeeded");
    expect(snapshot.uploads[0]!.parts.every((part) => part.attempts === 2)).toBe(true);
  });

  it("gives up after the configured number of Retries", async () => {
    const { snapshot, platform } = await run(
      { script: () => ({ kind: "network" }) },
      { maxRetries: 2, concurrency: 1 },
    );

    expect(snapshot.uploads[0]!.status).toBe("failed");
    expect(snapshot.uploads[0]!.error?.code).toBe("RETRIES_EXHAUSTED");
    // First Attempt plus two Retries.
    expect(platform.state.calls.filter((call) => call.partNumber === 1)).toHaveLength(3);
  });
});

describe("the backoff ladder", () => {
  it("doubles the window each Attempt", async () => {
    const platform = createFakePlatform({
      script: () => ({ kind: "network" }),
      randomValues: [1],
    });
    const batch = createUploader({
      files: [makeFile(25 * KB)],
      transport: createFakeTransport(),
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      maxRetries: 3,
      retryBaseMs: 100,
      retryMaxMs: 10_000,
      concurrency: 1,
    });

    // Observed per Part rather than off the Platform's sleep log. A Part waiting
    // out its backoff releases its Connection Budget slot, so a sibling's first
    // Retry interleaves with this one's second — the ladder belongs to the Part,
    // not to the Batch.
    const delays: number[] = [];
    batch.on("part:retrying", ({ partNumber, delayMs }) => {
      if (partNumber === 1) delays.push(delayMs);
    });

    await batch.start();

    // Full jitter at random()===1 yields the top of each window: 100, 200, 400.
    expect(delays).toEqual([100, 200, 400]);
  });

  it("never exceeds the ceiling", async () => {
    const { platform } = await run(
      { script: () => ({ kind: "network" }), randomValues: [1] },
      { maxRetries: 5, retryBaseMs: 1000, retryMaxMs: 2500, concurrency: 1 },
    );

    expect(Math.max(...platform.state.sleeps)).toBeLessThanOrEqual(2500);
  });

  it("draws across the whole window rather than adding to a floor", async () => {
    const { platform } = await run(
      { script: () => ({ kind: "network" }), randomValues: [0] },
      { maxRetries: 2, retryBaseMs: 500, concurrency: 1 },
    );

    // Full jitter can legitimately produce no delay at all; base-plus-jitter cannot.
    expect(platform.state.sleeps[0]).toBe(0);
  });

  it("announces each Retry with its delay", async () => {
    const platform = createFakePlatform({
      script: ({ attempt }) => (attempt === 1 ? { kind: "network" } : { kind: "ok" }),
      randomValues: [1],
    });
    const batch = createUploader({
      files: [makeFile(10 * KB)],
      transport: createFakeTransport(),
      platform,
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      retryBaseMs: 250,
    });

    const retrying = vi.fn();
    batch.on("part:retrying", retrying);
    await batch.start();

    expect(retrying).toHaveBeenCalledWith({
      id: "upload-1",
      partNumber: 1,
      attempt: 1,
      delayMs: 250,
    });
  });
});

describe("classifying failures", () => {
  it("retries 429", async () => {
    const { snapshot, platform } = await run({
      script: ({ attempt }) => (attempt === 1 ? { kind: "status", status: 429 } : { kind: "ok" }),
    });

    expect(snapshot.status).toBe("succeeded");
    expect(platform.state.calls.length).toBeGreaterThan(3);
  });

  it("retries 500, 502 and 503", async () => {
    for (const status of [500, 502, 503]) {
      const { snapshot } = await run({
        script: ({ attempt }) => (attempt === 1 ? { kind: "status", status } : { kind: "ok" }),
      });
      expect(snapshot.status).toBe("succeeded");
    }
  });

  it("retries a timeout", async () => {
    const { snapshot } = await run({
      script: ({ attempt }) => (attempt === 1 ? { kind: "timeout" } : { kind: "ok" }),
    });

    expect(snapshot.status).toBe("succeeded");
  });

  it("fails a 400 at once without working through the ladder", async () => {
    const { snapshot, platform } = await run(
      { script: () => ({ kind: "status", status: 400 }) },
      { concurrency: 1 },
    );

    expect(snapshot.uploads[0]!.status).toBe("failed");
    expect(platform.state.calls.filter((call) => call.partNumber === 1)).toHaveLength(1);
    expect(platform.state.sleeps).toHaveLength(0);
  });

  it("fails a 404 at once", async () => {
    const { platform } = await run(
      { script: () => ({ kind: "status", status: 404 }) },
      { concurrency: 1 },
    );

    expect(platform.state.calls.filter((call) => call.partNumber === 1)).toHaveLength(1);
  });

  it("honours a replaced classifier", async () => {
    const classify = vi.fn(() => "fatal" as const);
    const { snapshot } = await run(
      { script: () => ({ kind: "network" }) },
      { classify, concurrency: 1 },
    );

    expect(classify).toHaveBeenCalled();
    expect(snapshot.uploads[0]!.status).toBe("failed");
    // Fatal by the replaced rule, so no backoff was ever waited on.
    expect(snapshot.uploads[0]!.parts[0]!.attempts).toBe(1);
  });

  it("passes a per-Attempt timeout through to the Platform", async () => {
    const { platform } = await run({}, { partTimeoutMs: 9000 });

    expect(platform.state.calls).not.toHaveLength(0);
    expect(platform.state.calls.every((call) => call.timeoutMs === 9000)).toBe(true);
  });

  it("sends no deadline at all when none was asked for", async () => {
    const { platform } = await run({});

    // 0 is the documented "disabled", and it must reach the Platform as 0
    // rather than as some default the Core invented.
    expect(platform.state.calls.every((call) => call.timeoutMs === 0)).toBe(true);
  });
});

describe("the default classifier in isolation", () => {
  const ctx = { alreadyReopened: false };

  it("retries connection failures and timeouts", () => {
    expect(defaultClassifier(Object.assign(new Error(""), { name: "NetworkError" }), ctx)).toBe(
      "retry",
    );
    expect(defaultClassifier(Object.assign(new Error(""), { name: "TimeoutError" }), ctx)).toBe(
      "retry",
    );
  });

  it("treats an abort as fatal so Cancel is not fought", () => {
    expect(defaultClassifier(Object.assign(new Error(""), { name: "AbortError" }), ctx)).toBe(
      "fatal",
    );
  });

  it("re-Opens on 403 once, then gives up", () => {
    const forbidden = Object.assign(new Error(""), { name: "HttpError", status: 403 });
    expect(defaultClassifier(forbidden, { alreadyReopened: false })).toBe("reopen");
    expect(defaultClassifier(forbidden, { alreadyReopened: true })).toBe("fatal");
  });

  it("treats 401 the same as 403", () => {
    const unauthorised = Object.assign(new Error(""), { name: "HttpError", status: 401 });
    expect(defaultClassifier(unauthorised, { alreadyReopened: false })).toBe("reopen");
  });

  it("treats an unrecognised throw as transient", () => {
    expect(defaultClassifier(new Error("who knows"), ctx)).toBe("retry");
  });
});
