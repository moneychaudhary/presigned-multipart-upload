// Angular compiled in the browser (JIT), so the playground needs no Angular CLI.
// Component() is called as a function rather than used as a decorator, which
// keeps this file plain TypeScript for Vite.
import "@angular/compiler";
import { Component, computed, provideZonelessChangeDetection, signal } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { createAngularUploader, type AngularUploader } from "presigned-multipart-upload/angular";

import { mountChrome } from "../shared/chrome";
import { feed, summaryView, uploaderOptions, uploadView, type FeedEntry } from "../shared/demo";
import "../shared/styles.css";

class UploadStudio {
  readonly upload = signal<AngularUploader | null>(null);
  readonly entries = signal<FeedEntry[]>([]);
  readonly summary = computed(() => {
    const u = this.upload();
    return u ? summaryView(u.snapshot()) : null;
  });
  readonly rows = computed(() => this.upload()?.snapshot().uploads.map(uploadView) ?? []);
  private stopFeed: () => void = () => undefined;

  readonly choose = (event: Event): void => {
    const files = [...((event.target as HTMLInputElement).files ?? [])];
    // A new selection is a new Batch: release the old one first.
    this.stopFeed();
    this.upload()?.dispose();
    this.entries.set([]);
    if (files.length === 0) return this.upload.set(null);
    const upload = createAngularUploader(uploaderOptions(files));
    this.stopFeed = feed(upload.uploader, (entry) =>
      this.entries.update((all) => [entry, ...all].slice(0, 60)),
    );
    this.upload.set(upload);
  };
}

const App = Component({
  selector: "upload-studio",
  template: `
    <section class="layout">
      <div class="col-main">
        <label class="dropzone" data-testid="dropzone">
          <input type="file" multiple hidden data-testid="file-input" (change)="choose($event)" />
          <span class="dz-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <path d="M12 16V4m0 0-5 5m5-5 5 5M4 20h16" />
            </svg>
          </span>
          <span class="dz-text">
            <strong>Choose files to upload</strong>
            <span>Large files go up in parts, small ones in a single PUT. Pick several at once.</span>
          </span>
        </label>

        @if (summary(); as s) {
          <div class="card summary" data-testid="summary" [attr.data-status]="s.status">
            <div class="summary-head">
              <span class="pill pill-{{ s.status }}" data-testid="status" [attr.data-status]="s.status">{{ s.label }}</span>
              <span class="muted">{{ s.count }}</span>
            </div>
            <div class="big">
              <strong data-testid="percent">{{ s.percent }}%</strong>
              <span>{{ s.sent }}</span>
            </div>
            <div class="bar"><div class="bar-fill" [style.width.%]="s.percent"></div></div>
            <div class="stats">
              <div class="stat"><label>Speed</label><b data-testid="speed">{{ s.speed }}</b></div>
              <div class="stat"><label>Time left</label><b data-testid="remaining">{{ s.remaining }}</b></div>
              <div class="stat"><label>Status</label><b>{{ s.label }}</b></div>
            </div>
            <div class="actions">
              <button class="btn btn-primary" data-testid="start" [disabled]="!s.canStart" (click)="upload()!.start()">Upload</button>
              <button class="btn" data-testid="pause" [disabled]="!s.canPause" (click)="upload()!.pause()">Pause</button>
              <button class="btn" data-testid="resume" [disabled]="!s.canResume" (click)="upload()!.resume()">Resume</button>
              <button class="btn btn-ghost" data-testid="cancel" [disabled]="!s.canCancel" (click)="upload()!.cancel()">Cancel</button>
            </div>
          </div>
          <h2 class="list-title">Files</h2>
          <div class="list">
            @for (u of rows(); track u.id) {
              <article class="card upload" data-testid="upload-row" [attr.data-status]="u.status"
                       [attr.data-key]="u.key" [attr.data-upload-id]="u.uploadId" [attr.data-landed]="u.landed">
                <div class="upload-head">
                  <span class="file-icon">{{ u.ext }}</span>
                  <span class="upload-meta"><strong>{{ u.name }}</strong><span class="muted">{{ u.size }} · {{ u.mode }}</span></span>
                  <span class="pill pill-{{ u.status }}">{{ u.label }}</span>
                </div>
                <div class="bar thin"><div class="bar-fill" [style.width.%]="u.percent"></div></div>
                <div class="parts">
                  @for (p of u.parts; track p.n) {
                    <span class="part part-{{ p.status }}" [title]="'Part ' + p.n + ': ' + p.status"></span>
                  }
                </div>
                <div class="upload-foot muted"><span>{{ u.percent }}% · {{ u.speed }}</span><code>{{ u.key }}</code></div>
                @if (u.error) { <div class="upload-error">{{ u.error }}</div> }
              </article>
            }
          </div>
        } @else {
          <div class="card empty"><strong>No files yet</strong>Pick some files and press Upload.</div>
        }
      </div>

      <aside class="col-side">
        <div class="card log">
          <h3>Activity</h3>
          <span class="muted">Events from <code>uploader.on()</code></span>
          <ol data-testid="log">
            @for (entry of entries(); track $index) {
              <li [class]="entry.kind"><span>{{ entry.text }}<time>{{ entry.at }}</time></span></li>
            } @empty {
              <li class="muted">Nothing yet.</li>
            }
          </ol>
        </div>
      </aside>
    </section>
  `,
})(UploadStudio);

mountChrome("angular");
const host = document.createElement("upload-studio");
document.getElementById("app")!.append(host);
void bootstrapApplication(App, { providers: [provideZonelessChangeDetection()] });
