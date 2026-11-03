// @vitest-environment happy-dom
import { computed, effectScope, isReadonly, isRef, toRaw } from "vue";
import { describe, expect, it, vi } from "vitest";

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

  it("updates as the Upload moves, and computed values see it", async () => {
    const controller = build();
    const scope = effectScope();
    const { u, status } = scope.run(() => {
      const u = useUploader(controller);
      return { u, status: computed(() => u.snapshot.value.status) };
    })!;
    expect(status.value).toBe("idle");

    await u.start();

    expect(u.snapshot.value.status).toBe("succeeded");
    expect(u.snapshot.value).toBe(controller.getSnapshot());
    expect(status.value).toBe("succeeded");
    scope.stop();
  });

  it("is a read-only ref holding the Core's own object", () => {
    const controller = build();
    const scope = effectScope();
    const u = scope.run(() => useUploader(controller))!;
    const v = u.snapshot.value;

    expect(isReadonly(u.snapshot)).toBe(true);
    expect(isRef(u.snapshot)).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    (u.snapshot as { value: unknown }).value = build().getSnapshot();
    warn.mockRestore();
    expect(u.snapshot.value).toBe(v);
    expect(toRaw(v)).toBe(v);
    scope.stop();
  });
});
