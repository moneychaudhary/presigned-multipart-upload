// @vitest-environment happy-dom
import { act, render, screen } from "@testing-library/react";
import React from "react";
import { effectScope } from "vue";
import { describe, expect, it, vi } from "vitest";

import { createAngularUpload } from "../src/angular.js";
import { createBatch } from "../src/index.js";
import { useUpload, useUploadEvent } from "../src/react.js";
import type { BatchController } from "../src/index.js";
import { useUpload as useVueUpload } from "../src/vue.js";
import { flush } from "./fakes/async.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform, type Script } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

const build = (script?: Script): BatchController =>
  createBatch({
    files: [makeFile(25 * KB)],
    transport: createFakeTransport(),
    platform: createFakePlatform(script ? { script } : {}),
    partSize: 10 * KB,
    provider: { minPartSize: 1 },
  });

describe("the React adapter", () => {
  it("renders current state and updates as the Upload moves", async () => {
    const controller = build();

    const View = (): React.ReactElement => {
      const { snapshot } = useUpload(controller);
      return React.createElement("div", null, `${snapshot.status}:${snapshot.progress.percent}`);
    };

    render(React.createElement(View));
    expect(screen.getByText("idle:0")).toBeTruthy();

    await act(async () => {
      await controller.start();
    });

    expect(screen.getByText("succeeded:100")).toBeTruthy();
  });

  it("exposes the Batch's actions", () => {
    const controller = build();
    let actions: ReturnType<typeof useUpload> | null = null;

    const View = (): React.ReactElement => {
      actions = useUpload(controller);
      return React.createElement("div");
    };
    render(React.createElement(View));

    expect(typeof actions!.start).toBe("function");
    expect(typeof actions!.pause).toBe("function");
    expect(typeof actions!.resume).toBe("function");
    expect(typeof actions!.cancel).toBe("function");
  });

  it("does not re-render when nothing changed", async () => {
    const controller = build();
    const renders = vi.fn();

    const View = (): React.ReactElement => {
      useUpload(controller);
      renders();
      return React.createElement("div");
    };

    const { rerender } = render(React.createElement(View));
    const before = renders.mock.calls.length;
    rerender(React.createElement(View));

    // A parent re-render is one render; the store must not add more of its own.
    expect(renders.mock.calls.length).toBe(before + 1);
  });

  it("leaves no live subscription after unmount", async () => {
    const controller = build();
    const View = (): React.ReactElement => {
      useUpload(controller);
      return React.createElement("div");
    };

    const { unmount } = render(React.createElement(View));
    unmount();

    // If the subscription survived, React would warn about updating an
    // unmounted tree while this runs.
    await act(async () => {
      await controller.start();
    });
    expect(controller.getSnapshot().status).toBe("succeeded");
  });

  it("delivers lifecycle events while mounted", async () => {
    const controller = build();
    const landed = vi.fn();

    const View = (): React.ReactElement => {
      useUploadEvent(controller, "part:landed", landed);
      return React.createElement("div");
    };

    render(React.createElement(View));
    await act(async () => {
      await controller.start();
    });

    expect(landed).toHaveBeenCalledTimes(3);
  });

  it("keeps one subscription when the handler is an inline arrow", async () => {
    const controller = build();
    const on = vi.spyOn(controller, "on");

    const View = (): React.ReactElement => {
      useUploadEvent(controller, "part:landed", () => undefined);
      return React.createElement("div");
    };

    const { rerender } = render(React.createElement(View));
    rerender(React.createElement(View));
    rerender(React.createElement(View));

    expect(on).toHaveBeenCalledTimes(1);
  });
});

describe("the Vue adapter", () => {
  it("exposes a ref that tracks the snapshot", async () => {
    const controller = build();
    const { snapshot } = useVueUpload(controller);

    expect(snapshot.value.status).toBe("idle");
    await controller.start();
    expect(snapshot.value.status).toBe("succeeded");
  });

  it("stops tracking when its effect scope is disposed", async () => {
    const controller = build();
    const scope = effectScope();
    const held = scope.run(() => useVueUpload(controller))!;

    scope.stop();
    await controller.start();

    expect(held.snapshot.value.status).toBe("idle");
  });

  it("can be stopped explicitly", async () => {
    const controller = build();
    const { snapshot, stop } = useVueUpload(controller);

    stop();
    await controller.start();

    expect(snapshot.value.status).toBe("idle");
  });
});

describe("the Core's subscribe, used directly", () => {
  it("satisfies the readable-store contract", async () => {
    // No adapter ships for Svelte because none is needed: a readable store is
    // just a subscribe that calls back immediately and returns an unsubscriber,
    // which is exactly this. The docs promise `$batch` works unaided, so the
    // promise is tested.
    const controller = build();
    const seen: string[] = [];

    const unsubscribe = controller.subscribe((snapshot) => seen.push(snapshot.status));

    expect(seen).toEqual(["idle"]);

    await controller.start();
    expect(seen.at(-1)).toBe("succeeded");

    unsubscribe();
    const count = seen.length;
    await controller.resume();
    expect(seen).toHaveLength(count);
  });
});

describe("the Angular adapter", () => {
  it("exposes a signal that tracks the snapshot", async () => {
    const controller = build();
    const upload = createAngularUpload(controller);

    expect(upload.snapshot().status).toBe("idle");
    await controller.start();
    expect(upload.snapshot().status).toBe("succeeded");
  });

  it("emits equivalently through the Observable interop", async () => {
    const controller = build();
    const upload = createAngularUpload(controller);

    const seen: string[] = [];
    const subscription = upload.snapshot$.subscribe((snapshot) => seen.push(snapshot.status));

    expect(seen).toEqual(["idle"]);
    await controller.start();

    expect(seen.at(-1)).toBe("succeeded");
    expect(seen.at(-1)).toBe(upload.snapshot().status);

    subscription.unsubscribe();
  });

  it("stops tracking once destroyed", async () => {
    const controller = build();
    const upload = createAngularUpload(controller);

    upload.destroy();
    await controller.start();

    expect(upload.snapshot().status).toBe("idle");
  });

  it("exposes the Batch's actions", () => {
    const upload = createAngularUpload(build());
    expect(typeof upload.start).toBe("function");
    expect(typeof upload.resume).toBe("function");
  });
});

describe("the Core on its own", () => {
  it("pulls in no framework", async () => {
    const core = await import("../src/index.js");
    expect(typeof core.createBatch).toBe("function");
    // The Core's own module graph must never reach a framework entry point.
    expect(Object.keys(core)).not.toContain("useUpload");
  });

  it("still works with no adapter involved", async () => {
    const controller = build();
    await flush();
    expect((await controller.start()).status).toBe("succeeded");
  });
});
