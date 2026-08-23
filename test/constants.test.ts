import { describe, expect, it } from "vitest";

import {
  createUploader,
  PartStatus,
  UploaderStatus,
  UploadErrorCode,
  UploadEvent,
  UploadStatus,
} from "../src/index.js";
import type { EventName } from "../src/index.js";
import { KB, makeFile } from "./fakes/file.js";
import { createFakePlatform, type Script } from "./fakes/platform.js";
import { createFakeTransport } from "./fakes/transport.js";

/**
 * The constants exist so an adopter never types a status or an event name by
 * hand. They are worth nothing if they disagree with what the library actually
 * emits, so every assertion here compares a constant against observed output
 * rather than against another literal.
 */
describe("the exported constants", () => {
  const build = (script?: Script) =>
    createUploader({
      files: [makeFile(25 * KB)],
      transport: createFakeTransport(),
      platform: createFakePlatform(script ? { script } : {}),
      partSize: 10 * KB,
      provider: { minPartSize: 1 },
      store: null,
      maxRetries: 0,
    });

  it("names the statuses an Uploader actually reports", async () => {
    const uploader = build();
    expect(uploader.getSnapshot().status).toBe(UploaderStatus.Idle);

    const settled = await uploader.start();
    expect(settled.status).toBe(UploaderStatus.Succeeded);
    expect(settled.uploads[0]!.status).toBe(UploadStatus.Succeeded);
    expect(settled.uploads[0]!.parts.every((part) => part.status === PartStatus.Landed)).toBe(true);
  });

  it("names events that can be subscribed to", async () => {
    const uploader = build();
    const seen: string[] = [];

    uploader.on(UploadEvent.PartLanded, () => seen.push("landed"));
    uploader.on(UploadEvent.UploadSucceeded, () => seen.push("succeeded"));
    uploader.on(UploadEvent.Settled, () => seen.push("settled"));

    await uploader.start();

    expect(seen).toEqual(["landed", "landed", "landed", "succeeded", "settled"]);
  });

  it("names the codes a failure actually carries", async () => {
    const settled = await build(() => ({ kind: "no-etag" })).start();

    expect(settled.status).toBe(UploaderStatus.Failed);
    expect(settled.uploads[0]!.error?.code).toBe(UploadErrorCode.MissingETag);
  });
});

/**
 * An event added to `UploaderEvents` without a constant would be unreachable
 * through `UploadEvent`. `satisfies` catches a name that is wrong; this catches
 * one that is missing.
 */
export type EveryEventHasAConstant =
  Exclude<EventName, (typeof UploadEvent)[keyof typeof UploadEvent]> extends never ? true : false;

export const everyEventHasAConstant: EveryEventHasAConstant = true;
