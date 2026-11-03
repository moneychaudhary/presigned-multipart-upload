// @vitest-environment happy-dom
import {
  computed,
  createApp,
  defineComponent,
  effectScope,
  h,
  isReadonly,
  isRef,
  nextTick,
  toRaw,
} from "vue";
import { describe, expect, it, vi } from "vitest";

import { createUploader } from "../src/index.js";
import { useUploader, useUploaderEvent, type VueUploader } from "../src/vue.js";
import type { Uploader } from "../src/index.js";
import { flush } from "./fakes/async.js";
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

  it("stops updating after dispose, and the upload still finishes", async () => {
    const controller = build();
    const scope = effectScope();
    const u = scope.run(() => useUploader(controller))!;

    u.dispose();
    await u.start();

    expect(u.snapshot.value.status).toBe("idle");
    expect(controller.getSnapshot().status).toBe("succeeded");
    scope.stop();
  });

  it("stops updating when its effect scope stops", async () => {
    const controller = build();
    const scope = effectScope();
    const u = scope.run(() => useUploader(controller))!;
    const before = u.snapshot.value;

    scope.stop();
    await u.start();

    expect(u.snapshot.value).toBe(before);
    expect(controller.getSnapshot().status).toBe("succeeded");
  });

  it("lets dispose run before the scope stops", () => {
    const scope = effectScope();
    const u = scope.run(() => useUploader(build()))!;

    u.dispose();

    expect(() => scope.stop()).not.toThrow();
  });

  it("builds a new Uploader from options", async () => {
    const scope = effectScope();
    const u = scope.run(() =>
      useUploader({
        files: [makeFile(25 * KB)],
        transport: createFakeTransport(),
        platform: createFakePlatform(),
        partSize: 10 * KB,
        limits: { minPartSize: 1 },
      }),
    )!;

    expect(u.snapshot.value).toBe(u.uploader.getSnapshot());
    await u.start();
    expect(u.snapshot.value.status).toBe("succeeded");
    scope.stop();
  });

  it("uses an Uploader passed in as it is", () => {
    const controller = build();
    const scope = effectScope();
    const u = scope.run(() => useUploader(controller))!;

    expect(u.uploader).toBe(controller);
    scope.stop();
  });
});

describe("the Vue adapter outside an effect scope", () => {
  it("updates during an upload", async () => {
    const controller = build();
    const u = useUploader(controller);

    await u.start();

    expect(u.snapshot.value.status).toBe("succeeded");
    u.dispose();
  });

  it("is not stopped by an unrelated scope", async () => {
    const controller = build();
    const u = useUploader(controller);
    const other = effectScope();
    other.run(() => computed(() => 1).value);
    other.stop();

    await u.start();

    expect(u.snapshot.value.status).toBe("succeeded");
    u.dispose();
  });

  it("stops only when disposed", async () => {
    const controller = build();
    const u = useUploader(controller);

    u.dispose();
    await u.start();

    expect(u.snapshot.value.status).toBe("idle");
    expect(controller.getSnapshot().status).toBe("succeeded");
  });
});

describe("the Vue adapter in a mounted component", () => {
  const mountView = (controller: Uploader, renders = vi.fn()) => {
    let bound: VueUploader | null = null;
    const View = defineComponent({
      setup: () => {
        bound = useUploader(controller);
        const { snapshot } = bound;
        return () => {
          renders();
          return h("div", `${snapshot.value.status}:${snapshot.value.progress.percent}`);
        };
      },
    });
    const el = document.createElement("div");
    document.body.append(el);
    const app = createApp(View);
    app.mount(el);
    return { app, el, bound: bound! };
  };

  it("renders current state and updates as the Upload moves", async () => {
    const controller = build();
    const { app, el } = mountView(controller);
    expect(el.textContent).toBe("idle:0");

    await controller.start();
    await nextTick();

    expect(el.textContent).toBe("succeeded:100");
    app.unmount();
  });

  it("stops observing after unmount", async () => {
    const controller = build();
    const renders = vi.fn();
    const { app, bound } = mountView(controller, renders);
    const before = renders.mock.calls.length;

    app.unmount();
    await controller.start();
    await nextTick();

    expect(renders.mock.calls.length).toBe(before);
    expect(bound.snapshot.value.status).toBe("idle");
    expect(controller.getSnapshot().status).toBe("succeeded");
  });
});

describe("useUploaderEvent", () => {
  it("fires its handler with the event's payload inside a scope", async () => {
    const controller = build();
    const spy = vi.fn();
    const scope = effectScope();
    scope.run(() => useUploaderEvent(controller, "upload:succeeded", spy));

    await controller.start();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ id: controller.getSnapshot().upload!.id });
    scope.stop();
  });

  it("types the handler's payload by the event name", () => {
    const controller = build();
    const scope = effectScope();
    scope.run(() => {
      useUploaderEvent(controller, "upload:failed", ({ error }) => error.code);
      // @ts-expect-error upload:succeeded carries no error
      useUploaderEvent(controller, "upload:succeeded", ({ error }) => error);
    });
    scope.stop();
  });

  it("stops firing once off is called", async () => {
    const controller = build();
    const spy = vi.fn();
    const scope = effectScope();
    const off = scope.run(() => useUploaderEvent(controller, "upload:succeeded", spy))!;

    off();
    await controller.start();

    expect(spy).not.toHaveBeenCalled();
    scope.stop();
  });

  it("stops firing when its effect scope stops", async () => {
    const controller = build();
    const spy = vi.fn();
    const scope = effectScope();
    scope.run(() => useUploaderEvent(controller, "upload:succeeded", spy));

    scope.stop();
    await controller.start();

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("useUploaderEvent outside an effect scope", () => {
  it("keeps firing after an unrelated scope stops, until off is called", async () => {
    const controller = build(({ partNumber }) =>
      partNumber >= 3 ? { kind: "hang" } : { kind: "ok" },
    );
    const spy = vi.fn();
    const off = useUploaderEvent(controller, "upload:paused", spy);
    const other = effectScope();
    other.run(() => computed(() => 1).value);
    other.stop();

    const first = controller.start();
    await flush();
    await controller.pause();
    await first;
    expect(spy).toHaveBeenCalledTimes(1);

    off();
    const second = controller.resume();
    await flush();
    await controller.pause();
    await second;
    expect(controller.getSnapshot().status).toBe("paused");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
