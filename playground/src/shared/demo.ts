/**
 * Everything the four framework pages share, so each one is only the binding:
 * the demo's options, the uploader options built from them, a view model of a
 * snapshot, and a feed of the uploader's events.
 */
import {
  httpTransport,
  type Uploader,
  type UploaderOptions,
  type UploaderSnapshot,
  type UploadSnapshot,
} from "presigned-multipart-upload";
import {
  browserPlatform,
  networkFailure,
  type Platform,
} from "presigned-multipart-upload/advanced";

const MIB = 1024 * 1024;

export interface DemoOptions {
  /** Have S3 verify every part against a CRC32. */
  checksum: boolean;
  /** Send files that fit in one part as a single PUT. */
  single: boolean;
  /** Fail the first attempt of every third part, to show retries. */
  flaky: boolean;
  partMiB: number;
  concurrency: number;
}

/** Options live in the query string, so a demo state is a shareable link. */
export const readOptions = (search = location.search): DemoOptions => {
  const q = new URLSearchParams(search);
  const flag = (name: string, fallback: boolean) => (q.has(name) ? q.get(name) === "1" : fallback);
  return {
    checksum: flag("checksum", true),
    single: flag("single", true),
    flaky: flag("flaky", false),
    partMiB: Number(q.get("partMiB") ?? 5),
    concurrency: Number(q.get("concurrency") ?? 3),
  };
};

/** A browser Platform whose first attempt at every third part drops, as a bad network would. */
const flakyPlatform = (): Platform => {
  const real = browserPlatform();
  const tried = new Set<string>();
  return {
    ...real,
    sendPart: async (args) => {
      const key = `${args.id}:${args.partNumber}`;
      if (args.partNumber % 3 === 0 && !tried.has(key)) {
        tried.add(key);
        await real.sleep(400);
        throw networkFailure(`Part ${args.partNumber} lost its connection (simulated)`);
      }
      return real.sendPart(args);
    },
  };
};

export const transport = (options: DemoOptions) =>
  httpTransport({
    baseUrl: "/api/uploads",
    ...(options.single ? {} : { paths: { single: null } }),
  });

export const uploaderOptions = (files: File[], options = readOptions()): UploaderOptions => ({
  files,
  transport: transport(options),
  partSize: options.partMiB * MIB,
  concurrency: options.concurrency,
  retry: { baseMs: 300 },
  ...(options.checksum ? { checksum: "CRC32" as const } : {}),
  ...(options.flaky ? { platform: flakyPlatform() } : {}),
});

/* ——— presentation ——— */

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
};

/** "—" until bytes are moving: a part queued for a connection is waiting, not stalled. */
const formatSpeed = (bytesPerSecond: number | null): string =>
  bytesPerSecond === null || bytesPerSecond <= 0 ? "—" : `${formatBytes(bytesPerSecond)}/s`;

const formatRemaining = (ms: number | null): string => {
  if (ms === null) return "—";
  const seconds = Math.ceil(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const LABELS: Record<string, string> = {
  idle: "Ready",
  pending: "Waiting",
  opening: "Starting",
  uploading: "Uploading",
  completing: "Finishing",
  succeeded: "Uploaded",
  failed: "Failed",
  paused: "Paused",
  cancelled: "Cancelled",
};

export interface UploadView {
  id: string;
  name: string;
  ext: string;
  size: string;
  mode: string;
  status: string;
  label: string;
  percent: number;
  speed: string;
  key: string;
  uploadId: string;
  landed: number;
  parts: { n: number; status: string }[];
  error: string | null;
}

export const uploadView = (upload: UploadSnapshot): UploadView => {
  const name = upload.file.name;
  const single = upload.key !== null && upload.uploadId === null;
  return {
    id: upload.id,
    name,
    ext: (name.split(".").pop() ?? "file").slice(0, 4).toUpperCase(),
    size: formatBytes(upload.file.size),
    mode:
      upload.parts.length === 0
        ? "Not started"
        : single
          ? "Single PUT"
          : `Multipart · ${upload.parts.length} parts`,
    status: upload.status,
    label: LABELS[upload.status] ?? upload.status,
    percent: Math.floor(upload.progress.percent),
    speed: formatSpeed(upload.progress.bytesPerSecond),
    key: upload.key ?? "",
    uploadId: upload.uploadId ?? "",
    landed: upload.parts.filter((part) => part.status === "landed").length,
    parts: upload.parts.map((part) => ({ n: part.partNumber, status: part.status })),
    error: upload.error ? `${upload.error.code}: ${upload.error.message}` : null,
  };
};

export interface SummaryView {
  status: string;
  label: string;
  percent: number;
  speed: string;
  remaining: string;
  sent: string;
  count: string;
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
}

export const summaryView = (snapshot: UploaderSnapshot): SummaryView => {
  const { status, progress, uploads } = snapshot;
  return {
    status,
    label: LABELS[status] ?? status,
    percent: Math.floor(progress.percent),
    speed: formatSpeed(progress.bytesPerSecond),
    remaining: formatRemaining(progress.remainingMs),
    sent: `${formatBytes(progress.loaded)} of ${formatBytes(progress.total)}`,
    count: `${uploads.length} ${uploads.length === 1 ? "file" : "files"}`,
    canStart: status === "idle",
    canPause: status === "uploading",
    canResume: uploads.some((upload) => upload.resumable),
    canCancel: status === "uploading" || status === "paused" || status === "failed",
  };
};

/* ——— events ——— */

export interface FeedEntry {
  at: string;
  kind: "info" | "good" | "warn" | "bad";
  text: string;
}

/** Turn the uploader's events into readable lines, newest first. Returns an unsubscriber. */
export const feed = (uploader: Uploader, push: (entry: FeedEntry) => void): (() => void) => {
  const nameOf = (id: string) =>
    uploader.getSnapshot().uploads.find((upload) => upload.id === id)?.file.name ?? id;
  const at = () =>
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const add = (kind: FeedEntry["kind"], text: string) => push({ at: at(), kind, text });
  const stops = [
    uploader.on("part:landed", ({ id, partNumber }) =>
      add("info", `${nameOf(id)} · part ${partNumber} stored`),
    ),
    uploader.on("part:retrying", ({ id, partNumber, attempt, delayMs }) =>
      add(
        "warn",
        `${nameOf(id)} · part ${partNumber} retrying after attempt ${attempt} (in ${delayMs} ms)`,
      ),
    ),
    uploader.on("upload:succeeded", ({ id }) => add("good", `${nameOf(id)} uploaded`)),
    uploader.on("upload:failed", ({ id, error }) =>
      add("bad", `${nameOf(id)} failed — ${error.code}`),
    ),
    uploader.on("upload:paused", ({ id }) => add("info", `${nameOf(id)} paused`)),
    uploader.on("upload:cancelled", ({ id }) =>
      add("bad", `${nameOf(id)} cancelled and torn down`),
    ),
  ];
  return () => stops.forEach((stop) => stop());
};
