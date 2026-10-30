// The Classifier reads `name` and `status` off whatever a Platform or Transport
// threw, so those two fields are the contract between them. The shapes are
// public, so anyone writing a Platform or a Transport can produce them — tested
// here because every Retry test in the suite runs against the fake, and if the
// fake and the browser Platform ever disagreed the suite would stay green.
import { describe, expect, it } from "vitest";

import {
  abortFailure,
  defaultClassifier,
  httpFailure,
  networkFailure,
  timeoutFailure,
} from "../src/advanced.js";

const verdict = (error: unknown, alreadyRefreshed = false) =>
  defaultClassifier(error, { alreadyRefreshed });

describe("what a Platform throws, and what the Classifier makes of it", () => {
  it("treats a lost connection as worth Retrying", () => {
    expect(networkFailure().name).toBe("NetworkError");
    expect(verdict(networkFailure())).toBe("retry");
  });

  it("treats a per-Attempt timeout as worth Retrying", () => {
    expect(timeoutFailure(5000).name).toBe("TimeoutError");
    expect(verdict(timeoutFailure(5000))).toBe("retry");
  });

  it("carries the status, which is the only thing distinguishing 403 from 500", () => {
    expect((httpFailure(403) as { status?: number }).status).toBe(403);
    expect(verdict(httpFailure(403))).toBe("refresh");
    expect(verdict(httpFailure(403), true)).toBe("fatal");
    expect(verdict(httpFailure(500))).toBe("retry");
    expect(verdict(httpFailure(429))).toBe("retry");
    expect(verdict(httpFailure(400))).toBe("fatal");
  });

  it("ends the Attempt when the Core aborted it, rather than Retrying its own decision", () => {
    expect(abortFailure().name).toBe("AbortError");
    expect(verdict(abortFailure())).toBe("fatal");
  });

  it("keeps the message it is given, so a log says which request failed", () => {
    expect(httpFailure(500, "Part 7 failed with status 500").message).toBe(
      "Part 7 failed with status 500",
    );
    expect(networkFailure("Part 7 never reached the network").message).toContain("Part 7");
  });
});
