import type { Platform, SendPartArgs, SendPartResult } from "../types.js";

const abortError = (message: string): Error =>
  Object.assign(new Error(message), { name: "AbortError" });

const namedError = (name: string, message: string, extra: object = {}): Error =>
  Object.assign(new Error(message), { name, ...extra });

/**
 * Send one Part with XMLHttpRequest.
 *
 * Not fetch: upload progress is not observable through it, and per-Part progress
 * is the point. An individual request must also be abortable for Cancel and
 * Pause to take effect now rather than after the current Part finishes.
 */
const sendPart = ({
  url,
  body,
  partNumber,
  contentType,
  timeoutMs,
  signal,
  onProgress,
}: SendPartArgs): Promise<SendPartResult> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(`Part ${partNumber} aborted before it started`));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    if (timeoutMs > 0) xhr.timeout = timeoutMs;

    const onAbortSignal = (): void => xhr.abort();
    signal.addEventListener("abort", onAbortSignal, { once: true });
    const cleanup = (): void => signal.removeEventListener("abort", onAbortSignal);

    if (onProgress) {
      xhr.upload.onprogress = (event: ProgressEvent): void => onProgress(event.loaded);
    }

    xhr.onload = (): void => {
      cleanup();
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(
          namedError("HttpError", `Part ${partNumber} failed with status ${xhr.status}`, {
            status: xhr.status,
          }),
        );
        return;
      }
      // S3 quotes the ETag, and the quotes are part of the value that
      // finalising expects, so the header is passed through verbatim.
      resolve({ eTag: xhr.getResponseHeader("ETag") });
    };

    xhr.onerror = (): void => {
      cleanup();
      reject(namedError("NetworkError", `Part ${partNumber} never reached the network`));
    };

    xhr.ontimeout = (): void => {
      cleanup();
      reject(namedError("TimeoutError", `Part ${partNumber} timed out after ${timeoutMs}ms`));
    };

    xhr.onabort = (): void => {
      cleanup();
      reject(abortError(`Part ${partNumber} aborted`));
    };

    xhr.send(body);
  });

export const browserPlatform = (): Platform => ({
  sendPart,
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      // An already-aborted signal never dispatches "abort" again, so without
      // this a Cancel raised before the sleep began would wait out the whole
      // backoff window.
      if (signal?.aborted) {
        resolve();
        return;
      }
      let timer: ReturnType<typeof setTimeout>;
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      timer = setTimeout(finish, ms);
      signal?.addEventListener("abort", finish, { once: true });
    }),
  random: () => Math.random(),
  isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
  onOnline: (listener) => {
    if (typeof window === "undefined") return () => undefined;
    window.addEventListener("online", listener);
    return () => window.removeEventListener("online", listener);
  },
  files: {
    isHandleSupported: () => typeof window !== "undefined" && "showOpenFilePicker" in window,

    requestPermission: async (handle) => {
      const target = handle as {
        queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
        requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
      };
      if (!target?.queryPermission || !target.requestPermission) return false;
      // Returning to a page always re-prompts, so query first and only prompt
      // when the answer is not already yes.
      if ((await target.queryPermission({ mode: "read" })) === "granted") return true;
      return (await target.requestPermission({ mode: "read" })) === "granted";
    },

    readFile: async (handle) => {
      const target = handle as { getFile?: () => Promise<File> };
      if (!target?.getFile) throw new Error("The stored handle cannot produce a file.");
      return target.getFile();
    },
  },
});
