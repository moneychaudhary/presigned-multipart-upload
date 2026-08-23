// The Classifier reads `name` and `status` off whatever a Platform threw, so
// those two fields are the contract between them. Tested here directly because
// every Retry test in the suite runs against the fake — if the fake and the
// browser Platform ever disagreed about a shape, the suite would stay green and
// the library would be broken in a browser.
import { describe, expect, it } from "vitest";

import { defaultClassifier } from "../src/index.js";
import {
  abortFailure,
  httpFailure,
  networkFailure,
  timeoutFailure,
} from "../src/platform/failures.js";

const verdict = (error: unknown, alreadyReopened = false) =>
  defaultClassifier(error, { alreadyReopened });

describe("what a Platform throws, and what the Classifier makes of it", () => {
  it("treats a lost connection as worth Retrying", () => {
    expect(networkFailure(3).name).toBe("NetworkError");
    expect(verdict(networkFailure(3))).toBe("retry");
  });

  it("treats a per-Attempt timeout as worth Retrying", () => {
    expect(timeoutFailure(3, 5000).name).toBe("TimeoutError");
    expect(verdict(timeoutFailure(3, 5000))).toBe("retry");
  });

  it("carries the status, which is the only thing distinguishing 403 from 500", () => {
    expect((httpFailure(3, 403) as { status?: number }).status).toBe(403);
    expect(verdict(httpFailure(3, 403))).toBe("reopen");
    expect(verdict(httpFailure(3, 500))).toBe("retry");
    expect(verdict(httpFailure(3, 400))).toBe("fatal");
  });

  it("ends the Attempt when the Core aborted it, rather than Retrying its own decision", () => {
    expect(abortFailure("Part 3 aborted").name).toBe("AbortError");
    expect(verdict(abortFailure("Part 3 aborted"))).toBe("fatal");
  });

  it("names the Part in every message, so a log says which one", () => {
    for (const error of [networkFailure(7), timeoutFailure(7, 1), httpFailure(7, 500)]) {
      expect(error.message).toContain("Part 7");
    }
  });
});
