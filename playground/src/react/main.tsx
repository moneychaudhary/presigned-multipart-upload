import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useUploader } from "presigned-multipart-upload/react";

import { mountChrome } from "../shared/chrome";
import { feed, summaryView, uploaderOptions, uploadView, type FeedEntry } from "../shared/demo";
import "../shared/styles.css";

const UploadIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
  >
    <path d="M12 16V4m0 0-5 5m5-5 5 5M4 20h16" />
  </svg>
);

const Dropzone = ({ onFiles }: { onFiles: (files: File[]) => void }) => (
  <label className="dropzone" data-testid="dropzone">
    <input
      type="file"
      multiple
      hidden
      data-testid="file-input"
      onChange={(event) => onFiles([...(event.target.files ?? [])])}
    />
    <span className="dz-icon">
      <UploadIcon />
    </span>
    <span className="dz-text">
      <strong>Choose files to upload</strong>
      <span>Large files go up in parts, small ones in a single PUT. Pick several at once.</span>
    </span>
  </label>
);

const Log = ({ entries }: { entries: FeedEntry[] }) => (
  <aside className="col-side">
    <div className="card log">
      <h3>Activity</h3>
      <span className="muted">
        Events from <code>uploader.on()</code>
      </span>
      <ol data-testid="log">
        {entries.length === 0 && <li className="muted">Nothing yet.</li>}
        {entries.map((entry, index) => (
          <li key={index} className={entry.kind}>
            <span>
              {entry.text}
              <time>{entry.at}</time>
            </span>
          </li>
        ))}
      </ol>
    </div>
  </aside>
);

const Layout = ({ main, entries }: { main: ReactNode; entries: FeedEntry[] }) => (
  <section className="layout">
    <div className="col-main">{main}</div>
    <Log entries={entries} />
  </section>
);

/** One Batch: rebuilt by React only when the selected files change. */
const Batch = ({ files, dropzone }: { files: File[]; dropzone: ReactNode }) => {
  const { snapshot, uploader, start, pause, resume, cancel } = useUploader(uploaderOptions(files));
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  useEffect(
    () => feed(uploader, (entry) => setEntries((all) => [entry, ...all].slice(0, 60))),
    [uploader],
  );

  const s = summaryView(snapshot);
  return (
    <Layout
      entries={entries}
      main={
        <>
          {dropzone}
          <div className="card summary" data-testid="summary" data-status={s.status}>
            <div className="summary-head">
              <span className={`pill pill-${s.status}`} data-testid="status" data-status={s.status}>
                {s.label}
              </span>
              <span className="muted">{s.count}</span>
            </div>
            <div className="big">
              <strong data-testid="percent">{s.percent}%</strong>
              <span>{s.sent}</span>
            </div>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${s.percent}%` }} />
            </div>
            <div className="stats">
              <div className="stat">
                <label>Speed</label>
                <b data-testid="speed">{s.speed}</b>
              </div>
              <div className="stat">
                <label>Time left</label>
                <b data-testid="remaining">{s.remaining}</b>
              </div>
              <div className="stat">
                <label>Status</label>
                <b>{s.label}</b>
              </div>
            </div>
            <div className="actions">
              <button
                className="btn btn-primary"
                data-testid="start"
                disabled={!s.canStart}
                onClick={() => void start()}
              >
                Upload
              </button>
              <button
                className="btn"
                data-testid="pause"
                disabled={!s.canPause}
                onClick={() => void pause()}
              >
                Pause
              </button>
              <button
                className="btn"
                data-testid="resume"
                disabled={!s.canResume}
                onClick={() => void resume()}
              >
                Resume
              </button>
              <button
                className="btn btn-ghost"
                data-testid="cancel"
                disabled={!s.canCancel}
                onClick={() => void cancel()}
              >
                Cancel
              </button>
            </div>
          </div>
          <h2 className="list-title">Files</h2>
          <div className="list">
            {snapshot.uploads.map(uploadView).map((u) => (
              <article
                key={u.id}
                className="card upload"
                data-testid="upload-row"
                data-status={u.status}
                data-key={u.key}
                data-upload-id={u.uploadId}
                data-landed={u.landed}
              >
                <div className="upload-head">
                  <span className="file-icon">{u.ext}</span>
                  <span className="upload-meta">
                    <strong>{u.name}</strong>
                    <span className="muted">
                      {u.size} · {u.mode}
                    </span>
                  </span>
                  <span className={`pill pill-${u.status}`}>{u.label}</span>
                </div>
                <div className="bar thin">
                  <div className="bar-fill" style={{ width: `${u.percent}%` }} />
                </div>
                <div className="parts">
                  {u.parts.map((p) => (
                    <span
                      key={p.n}
                      className={`part part-${p.status}`}
                      title={`Part ${p.n}: ${p.status}`}
                    />
                  ))}
                </div>
                <div className="upload-foot muted">
                  <span>
                    {u.percent}% · {u.speed}
                  </span>
                  <code>{u.key}</code>
                </div>
                {u.error && <div className="upload-error">{u.error}</div>}
              </article>
            ))}
          </div>
        </>
      }
    />
  );
};

const App = () => {
  const [files, setFiles] = useState<File[]>([]);
  const dropzone = <Dropzone onFiles={setFiles} />;
  if (files.length === 0) {
    return (
      <Layout
        entries={[]}
        main={
          <>
            {dropzone}
            <div className="card empty">
              <strong>No files yet</strong>Pick some files and press Upload.
            </div>
          </>
        }
      />
    );
  }
  return <Batch files={files} dropzone={dropzone} />;
};

mountChrome("react");
createRoot(document.getElementById("app")!).render(<App />);
