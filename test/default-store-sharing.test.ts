// @vitest-environment happy-dom
import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";

import { createUploader, listResumable } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

/**
 * The default store is resolved on every `createUploader` and every
 * `listResumable`. Building a fresh IndexedDB adapter each time opened a
 * connection each time, and the adapter holds its connection open on purpose —
 * so a page that uploads many files accumulated connections it could not close.
 */
describe("the default Record Store", () => {
  it("opens one connection however many callers ask for it", async () => {
    const realOpen = indexedDB.open.bind(indexedDB);
    let opens = 0;
    Object.defineProperty(indexedDB, "open", {
      configurable: true,
      value: (...args: [string, number?]) => {
        opens += 1;
        return realOpen(...args);
      },
    });

    try {
      for (let i = 0; i < 5; i += 1) {
        await createUploader({
          files: [makeFile(25 * KB)],
          transport: createFakeTransport(),
          platform: createFakePlatform(),
          partSize: 10 * KB,
          provider: { minPartSize: 1 },
        }).start();
      }
      await listResumable();
      await listResumable();

      expect(opens).toBe(1);
    } finally {
      Object.defineProperty(indexedDB, "open", { configurable: true, value: realOpen });
    }
  });
});
