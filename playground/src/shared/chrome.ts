/**
 * The page around each framework demo: header, framework tabs, option toggles,
 * and the card for uploads interrupted by a reload. Plain DOM, so it is the
 * same on every page and no framework owns it.
 */
import { listResumable, resumeUploader, type ResumableUpload } from "presigned-multipart-upload";

import { formatBytes, readOptions, transport, type DemoOptions } from "./demo";

const FRAMEWORKS = [
  { id: "react", label: "React" },
  { id: "angular", label: "Angular" },
];

const TOGGLES: { key: keyof DemoOptions; label: string; hint: string }[] = [
  { key: "checksum", label: "Checksums", hint: "S3 verifies every part's CRC32" },
  { key: "single", label: "Single PUT", hint: "Small files skip multipart" },
  { key: "flaky", label: "Flaky network", hint: "Every third part drops once" },
];

const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const withOption = (key: string, value: string): string => {
  const q = new URLSearchParams(location.search);
  q.set(key, value);
  return `?${q}`;
};

export const mountChrome = (framework: string): void => {
  const options = readOptions();
  const root = document.getElementById("chrome")!;

  root.innerHTML = `
    <header class="topbar">
      <a class="brand" href="/">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32"><path d="M16 4 6 14h6v10h8V14h6z" fill="currentColor"/></svg>
        </span>
        <span>upload<b>studio</b></span>
      </a>
      <nav class="tabs" aria-label="Framework">
        ${FRAMEWORKS.map(
          (f) =>
            `<a class="tab ${f.id === framework ? "is-active" : ""}" href="/${f.id}.html${location.search}">${f.label}</a>`,
        ).join("")}
      </nav>
      <span class="topbar-note">S3 · LocalStack</span>
    </header>

    <section class="hero">
      <h1>Upload anything, <span class="accent">any size.</span></h1>
      <p>Presigned multipart uploads to S3 from ${escape(FRAMEWORKS.find((f) => f.id === framework)?.label ?? "")} —
      retries, pause, resume and cancel, straight from the browser.</p>
      <div class="chips" role="group" aria-label="Options">
        ${TOGGLES.map(
          (t) => `
          <a class="chip ${options[t.key] ? "is-on" : ""}" data-testid="toggle-${t.key}"
             href="${withOption(t.key, options[t.key] ? "0" : "1")}" title="${t.hint}">
            <span class="chip-dot"></span>${t.label}
          </a>`,
        ).join("")}
        <span class="chip chip-static">Parts of ${options.partMiB} MB · ${options.concurrency} at a time</span>
      </div>
    </section>

    <section id="interrupted"></section>
  `;

  void renderInterrupted(options);
};

/** Uploads a reload interrupted: the Record survived, the bytes need re-selecting. */
const renderInterrupted = async (options: DemoOptions): Promise<void> => {
  const host = document.getElementById("interrupted")!;
  const found = await listResumable();
  if (found.length === 0) {
    host.innerHTML = "";
    return;
  }

  host.innerHTML = `
    <div class="card interrupted" data-testid="interrupted">
      <div class="interrupted-head">
        <div>
          <h3>Pick up where you left off</h3>
          <p class="muted">These uploads were interrupted by a reload. Re-select the file and only the missing parts are sent.</p>
        </div>
      </div>
      ${found.map(row).join("")}
    </div>`;

  host.querySelectorAll<HTMLInputElement>("input[data-resume]").forEach((input) => {
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      const line = input.closest(".resume-row")!;
      const status = line.querySelector(".resume-status")!;
      try {
        const uploader = await resumeUploader({
          transport: transport(options),
          resume: [{ id: input.dataset.resume!, file }],
          ...(options.checksum ? { checksum: "CRC32" as const } : {}),
        });
        uploader.subscribe((s) => {
          status.textContent = `${s.status} · ${Math.floor(s.progress.percent)}%`;
          line.setAttribute("data-status", s.status);
        });
        await uploader.resume();
      } catch (error) {
        status.textContent = (error as { code?: string }).code ?? String(error);
        line.setAttribute("data-status", "failed");
      }
    });
  });
};

const row = (upload: ResumableUpload): string => `
  <div class="resume-row" data-testid="resume-row" data-status="paused">
    <div class="file-icon small">${escape((upload.file.name.split(".").pop() ?? "").slice(0, 4).toUpperCase())}</div>
    <div class="resume-meta">
      <strong>${escape(upload.file.name)}</strong>
      <span class="muted">${formatBytes(upload.file.size)} · ${upload.landedPartCount} of ${upload.partCount} parts stored</span>
      <div class="bar thin"><div class="bar-fill" style="width:${(upload.landedPartCount / upload.partCount) * 100}%"></div></div>
    </div>
    <span class="resume-status muted"></span>
    <label class="btn btn-small">Re-select &amp; resume
      <input type="file" hidden data-resume="${upload.id}" data-testid="resume-input">
    </label>
  </div>`;
