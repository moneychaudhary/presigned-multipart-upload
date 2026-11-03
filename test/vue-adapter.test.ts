// @vitest-environment happy-dom
import { effectScope } from "vue";
import { describe, expect, it } from "vitest";

import { createUploader } from "../src/index.js";
import { useUploader } from "../src/vue.js";
import type { Uploader } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform, type Script } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const build = (script?: Script): Uploader =>
  createUploader({
    files: [makeFile(25 * KB)],
    transport: createFakeTransport(),
    platform: createFakePlatform(script ? { script } : {}),
    partSize: 10 * KB,
    limits: { minPartSize: 1 },
  });

describe("the Vue adapter", () => {
  it("holds the current snapshot as soon as it returns", () => {
    const controller = build();
    const scope = effectScope();
    const u = scope.run(() => useUploader(controller))!;

    expect(u.snapshot.value).toBe(controller.getSnapshot());
    expect(u.snapshot.value.status).toBe("idle");
    scope.stop();
  });
});
