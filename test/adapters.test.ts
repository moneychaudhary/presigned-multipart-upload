// @vitest-environment happy-dom
import { act, render, screen } from "@testing-library/react";
import React from "react";
import { effectScope } from "vue";
import { describe, expect, it, vi } from "vitest";

import { createUploader as createAngularUploader } from "../src/angular.js";
import { createUploader } from "../src/index.js";
import { useUploader, useUploaderEvent } from "../src/react.js";
import type { Uploader } from "../src/index.js";
import { useUploader as useVueUpload } from "../src/vue.js";
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
    provider: { minPartSize: 1 },
  });

describe("the React adapter", () => {
  it("renders current state and updates as the Upload moves", async () => {
    const controller = build();

    const View = (): React.ReactElement => {
      const { snapshot } = useUploader(controller);
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
    let actions: ReturnType<typeof useUploader> | null = null;

    const View = (): React.ReactElement => {
      actions = useUploader(controller);
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
      useUploader(controller);
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
      useUploader(controller);
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
      useUploaderEvent(controller, "part:landed", landed);
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
      useUploaderEvent(controller, "part:landed", () => undefined);
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
    // subscribe calls back immediately and returns an unsubscriber. Frameworks
    // whose store contract is exactly that can bind to the Core with no adapter,
    // so the shape is pinned here.
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
  const buildAngular = (): ReturnType<typeof createAngularUploader> =>
    createAngularUploader({
      files: [makeFile(25 * KB)],
      transport: createFakeTransport(),
      platform: createFakePlatform(),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
    });

  it("exposes a signal that tracks the snapshot", async () => {
    const upload = buildAngular();

    expect(upload.snapshot().status).toBe("idle");
    await upload.start();
    expect(upload.snapshot().status).toBe("succeeded");
  });

  it("emits equivalently through the Observable interop", async () => {
    const upload = buildAngular();

    const seen: string[] = [];
    const subscription = upload.snapshot$.subscribe((snapshot) => seen.push(snapshot.status));

    expect(seen).toEqual(["idle"]);
    await upload.start();

    expect(seen.at(-1)).toBe("succeeded");
    expect(seen.at(-1)).toBe(upload.snapshot().status);

    subscription.unsubscribe();
  });

  it("stops tracking once destroyed", async () => {
    const upload = buildAngular();

    upload.destroy();
    await upload.start();

    expect(upload.snapshot().status).toBe("idle");
  });

  it("exposes the Uploader's actions, and the Uploader itself for events", () => {
    const upload = buildAngular();
    expect(typeof upload.start).toBe("function");
    expect(typeof upload.resume).toBe("function");
    expect(typeof upload.uploader.on).toBe("function");
  });
});

describe("an Adapter given options instead of an Uploader", () => {
  const options = () => ({
    files: [makeFile(25 * KB)],
    transport: createFakeTransport(),
    platform: createFakePlatform(),
    partSize: 10 * KB,
    provider: { minPartSize: 1 },
    store: null,
  });

  it("builds the Uploader itself, in React", async () => {
    let result: ReturnType<typeof useUploader> | null = null;
    const files = [makeFile(25 * KB)];

    const View = (): React.ReactElement => {
      result = useUploader({ ...options(), files });
      return React.createElement("div", null, result.snapshot.status);
    };

    render(React.createElement(View));
    expect(screen.getByText("idle")).toBeTruthy();

    await act(async () => {
      await result!.start();
    });
    expect(screen.getByText("succeeded")).toBeTruthy();
  });

  it("keeps the same Uploader across renders when the file list has not changed", () => {
    const files = [makeFile(25 * KB)];
    const seen: unknown[] = [];

    // A fresh options object every render; only the files are stable, which is
    // exactly how a component that builds its transport inline behaves.
    const View = (): React.ReactElement => {
      seen.push(useUploader({ ...options(), files }).uploader);
      return React.createElement("div");
    };

    const { rerender } = render(React.createElement(View));
    rerender(React.createElement(View));
    rerender(React.createElement(View));

    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(1);
  });

  it("builds a new Uploader when the file list changes", () => {
    const seen: unknown[] = [];

    const View = ({ files }: { files: File[] }): React.ReactElement => {
      seen.push(useUploader({ ...options(), files }).uploader);
      return React.createElement("div");
    };

    const { rerender } = render(React.createElement(View, { files: [makeFile(25 * KB)] }));
    rerender(React.createElement(View, { files: [makeFile(25 * KB)] }));

    expect(new Set(seen).size).toBe(2);
  });

  it("builds the Uploader itself, in Vue", async () => {
    const scope = effectScope();
    const bound = scope.run(() => useVueUpload(options()))!;

    expect(bound.snapshot.value.status).toBe("idle");
    await bound.start();
    expect(bound.snapshot.value.status).toBe("succeeded");

    scope.stop();
  });

  it("builds the Uploader itself, in Angular", async () => {
    const upload = createAngularUploader(options());

    expect(upload.snapshot().status).toBe("idle");
    await upload.start();
    expect(upload.snapshot().status).toBe("succeeded");
  });

  it("still accepts an Uploader, so several components can share one", () => {
    const controller = build();

    expect(createAngularUploader(controller).uploader).toBe(controller);
    expect(effectScope().run(() => useVueUpload(controller))!.uploader).toBe(controller);
  });
});

describe("the Core on its own", () => {
  it("pulls in no framework", async () => {
    const core = await import("../src/index.js");
    expect(typeof core.createUploader).toBe("function");
    // The Core's own module graph must never reach a framework entry point.
    expect(Object.keys(core)).not.toContain("useUploader");
  });

  it("still works with no adapter involved", async () => {
    const controller = build();
    await flush();
    expect((await controller.start()).status).toBe("succeeded");
  });
});
