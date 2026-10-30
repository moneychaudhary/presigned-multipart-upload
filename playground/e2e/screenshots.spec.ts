/**
 * The README's screenshots, each a real state of a real upload against S3 on
 * LocalStack. Parts are slowed in flight so mid-upload states can be caught.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { bytesOf } from "./s3";

const MIB = 1024 * 1024;
const OUT = "screenshots";

const slowParts = (page: Page, ms: number) =>
  page.route(/localhost:4566\/pmu-playground\//, async (route) => {
    if (route.request().method() === "PUT") await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });

const files = (...specs: [string, number, string?][]) =>
  specs.map(([name, size, mimeType]) => ({
    name,
    buffer: bytesOf(size, name.length + 3),
    mimeType: mimeType ?? "application/octet-stream",
  }));

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true, animations: "disabled" });

test.use({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });

test("landing", async ({ page }) => {
  await page.goto("/");
  await shot(page, "landing");
});

test("react: a batch mid-upload", async ({ page }) => {
  await slowParts(page, 900);
  await page.goto("/react.html?concurrency=3");
  await page
    .getByTestId("file-input")
    .setInputFiles(
      files(
        ["holiday-video.mov", 30 * MIB, "video/quicktime"],
        ["raw-photos.zip", 16 * MIB, "application/zip"],
        ["notes.pdf", 2 * MIB, "application/pdf"],
      ),
    );
  await page.getByTestId("start").click();
  await expect(page.getByTestId("upload-row").first()).toHaveAttribute("data-landed", /^[2-4]$/, {
    timeout: 20_000,
  });
  await expect(page.getByTestId("speed")).not.toHaveText("—");
  await shot(page, "react-uploading");
  await page.getByTestId("cancel").click();
});

test("angular: paused part-way", async ({ page }) => {
  await slowParts(page, 700);
  await page.goto("/angular.html?concurrency=2");
  await page
    .getByTestId("file-input")
    .setInputFiles(files(["site-backup.tar", 40 * MIB], ["logo.svg", 300 * 1024, "image/svg+xml"]));
  await page.getByTestId("start").click();
  await expect(page.getByTestId("upload-row").first()).toHaveAttribute("data-landed", /^[3-5]$/, {
    timeout: 20_000,
  });
  await page.getByTestId("pause").click();
  await expect(page.getByTestId("status")).toHaveAttribute("data-status", "paused");
  await shot(page, "angular-paused");
});

test("angular: retries on a flaky network", async ({ page }) => {
  await slowParts(page, 250);
  await page.goto("/angular.html?flaky=1&concurrency=2");
  await page.getByTestId("file-input").setInputFiles(files(["dataset.parquet", 36 * MIB]));
  await page.getByTestId("start").click();
  await expect(page.getByTestId("status")).toHaveAttribute("data-status", "succeeded", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("log")).toContainText("retrying");
  await shot(page, "angular-flaky-network");
});

test("react: a finished batch, multipart and single PUT", async ({ page }) => {
  await page.goto("/react.html");
  await page
    .getByTestId("file-input")
    .setInputFiles(
      files(
        ["podcast-episode.mp3", 27 * MIB, "audio/mpeg"],
        ["cover.jpg", 640 * 1024, "image/jpeg"],
        ["transcript.txt", 48 * 1024, "text/plain"],
      ),
    );
  await page.getByTestId("start").click();
  await expect(page.getByTestId("status")).toHaveAttribute("data-status", "succeeded", {
    timeout: 30_000,
  });
  await shot(page, "react-done");
});

test("resume after a reload", async ({ page }) => {
  const path = join(mkdtempSync(join(tmpdir(), "pmu-")), "conference-talk.mp4");
  writeFileSync(path, bytesOf(52 * MIB, 31));
  await slowParts(page, 700);
  await page.goto("/react.html?concurrency=1");
  await page.getByTestId("file-input").setInputFiles(path);
  await page.getByTestId("start").click();
  await expect(page.getByTestId("upload-row").first()).toHaveAttribute("data-landed", "4", {
    timeout: 20_000,
  });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload();
  await expect(page.getByTestId("interrupted")).toContainText("conference-talk.mp4");
  await shot(page, "resume-after-reload");
});
