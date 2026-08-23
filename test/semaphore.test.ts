// The Connection Budget's ceiling is an invariant of createSemaphore, and the
// failure it prevents — surplus requests queueing beneath the network layer,
// reporting no progress, timing out having never been sent — is invisible
// through the public interface by construction. This is the module's own
// internal seam, tested directly for that reason.
import { describe, expect, it } from "vitest";

import { createSemaphore } from "../src/semaphore.js";

describe("the Connection Budget's ceiling", () => {
  it("admits up to the limit", async () => {
    const budget = createSemaphore(2);

    await budget.acquire();
    await budget.acquire();

    let third = false;
    void budget.acquire().then(() => {
      third = true;
    });
    await Promise.resolve();

    expect(third).toBe(false);
  });

  it("does not let a late acquirer barge into a slot being handed over", async () => {
    const budget = createSemaphore(2);

    const releaseFirst = await budget.acquire();
    await budget.acquire();

    // One caller queued behind the full budget.
    let queuedGotSlot = false;
    const queued = budget.acquire().then((release) => {
      queuedGotSlot = true;
      return release;
    });

    // A slot frees. The queued caller is owed it — but it can only take it on a
    // later microtask, and that gap is where a fresh acquirer used to slip in.
    releaseFirst();

    let bargerGotSlot = false;
    const barger = budget.acquire().then((release) => {
      bargerGotSlot = true;
      return release;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect([queuedGotSlot, bargerGotSlot]).not.toEqual([true, true]);

    // Tidy up so the pending acquires do not dangle.
    (await queued)();
    await barger;
  });

  it("hands slots on in the order they were asked for", async () => {
    const budget = createSemaphore(1);
    const order: number[] = [];

    const release = await budget.acquire();
    const waiters = [1, 2, 3].map((n) =>
      budget.acquire().then((done) => {
        order.push(n);
        done();
      }),
    );

    release();
    await Promise.all(waiters);

    expect(order).toEqual([1, 2, 3]);
  });

  it("ignores a release called twice", async () => {
    const budget = createSemaphore(1);

    const release = await budget.acquire();
    release();
    release();

    let second = false;
    void budget.acquire().then(() => {
      second = true;
    });
    await Promise.resolve();
    expect(second).toBe(true);

    let third = false;
    void budget.acquire().then(() => {
      third = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(third).toBe(false);
  });
});
