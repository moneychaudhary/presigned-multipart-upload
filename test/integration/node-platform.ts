import { randomUUID } from "node:crypto";

import type { Platform, SendPartArgs, SendPartResult } from "../../src/index.js";

const namedError = (name: string, message: string, extra: object = {}): Error =>
  Object.assign(new Error(message), { name, ...extra });

/**
 * A Platform for Node, used only by the integration test.
 *
 * The shipped browser Platform uses XMLHttpRequest because upload progress is
 * not observable through fetch. Node has no XHR and this test does not assert on
 * progress, so fetch is the right tool here — what is being proved is that the
 * ETag ordering and finalising shape satisfy a real S3 endpoint.
 */
export const nodePlatform = (): Platform => ({
  sendPart: async ({
    url,
    body,
    partNumber,
    contentType,
    signal,
    onProgress,
  }: SendPartArgs): Promise<SendPartResult> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "PUT",
        body: await body.arrayBuffer(),
        headers: contentType ? { "Content-Type": contentType } : undefined,
        signal,
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      throw namedError("NetworkError", `Part ${partNumber} never reached the network`);
    }

    if (!response.ok) {
      throw namedError("HttpError", `Part ${partNumber} failed with ${response.status}`, {
        status: response.status,
      });
    }

    onProgress?.(body.size);
    return { eTag: response.headers.get("etag") };
  },

  newId: () => randomUUID(),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
  isOnline: () => true,
  onOnline: () => () => undefined,
  files: {
    isHandleSupported: () => false,
    requestPermission: async () => false,
    readFile: async () => {
      throw new Error("File Handles are a browser concern");
    },
  },
});
