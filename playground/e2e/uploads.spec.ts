import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { bytesOf, contentTypeOf, exists, openMultipartKeys, storedBytes } from "./s3";

const MIB = 1024 * 1024;
const FRAMEWORKS = ["react", "angular"] as const;

const choose = (page: Page, files: { name: string; buffer: Buffer; mimeType?: string }[]) =>
  page.getByTestId("file-input").setInputFiles(
    files.map((f) => ({
      name: f.name,
      mimeType: f.mimeType ?? "application/octet-stream",
      buffer: f.buffer,
    })),
  );

const status = (page: Page) => page.getByTestId("status");
const rows = (page: Page) => page.getByTestId("upload-row");

/** Hold every part PUT to S3 for a moment, so a test can act mid-upload. */
const slowParts = async (page: Page, ms: number) =>
  page.route(/localhost:4566\/pmu-playground\//, async (route) => {
    if (route.request().method() === "PUT") await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });

for (const fw of FRAMEWORKS) {
  test.describe(fw, () => {
    test("uploads a large file in checksummed parts, byte for byte", async ({ page }) => {
      const bytes = bytesOf(23 * MIB, 7);
      await page.goto(`/${fw}.html?checksum=1`);
      await choose(page, [{ name: `${fw}-large.bin`, buffer: bytes }]);
      await page.getByTestId("start").click();

      await expect(status(page)).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
      const row = rows(page).first();
      await expect(row).toHaveAttribute("data-landed", "5");
      expect((await storedBytes((await row.getAttribute("data-key"))!)).equals(bytes)).toBe(true);
      await expect(page.getByTestId("log")).toContainText("uploaded");
    });

    test("sends a small file as one PUT, keeping its content type", async ({ page }) => {
      const bytes = bytesOf(900 * 1024, 3);
      await page.goto(`/${fw}.html`);
      await choose(page, [{ name: `${fw}-photo.jpg`, buffer: bytes, mimeType: "image/jpeg" }]);
      await page.getByTestId("start").click();

      await expect(status(page)).toHaveAttribute("data-status", "succeeded");
      const row = rows(page).first();
      await expect(row).toHaveAttribute("data-upload-id", "");
      const key = (await row.getAttribute("data-key"))!;
      expect((await storedBytes(key)).equals(bytes)).toBe(true);
      expect(await contentTypeOf(key)).toBe("image/jpeg");
    });

    test("pauses mid-upload and resumes to completion", async ({ page }) => {
      await slowParts(page, 700);
      const bytes = bytesOf(26 * MIB, 11);
      await page.goto(`/${fw}.html?concurrency=1`);
      await choose(page, [{ name: `${fw}-pause.bin`, buffer: bytes }]);
      await page.getByTestId("start").click();

      await expect(rows(page).first()).not.toHaveAttribute("data-landed", "0");
      await page.getByTestId("pause").click();
      await expect(status(page)).toHaveAttribute("data-status", "paused");
      // Nothing may still read as in flight once paused.
      await expect(rows(page).first().locator(".part-uploading")).toHaveCount(0);

      await page.getByTestId("resume").click();
      await expect(status(page)).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
      const key = (await rows(page).first().getAttribute("data-key"))!;
      expect((await storedBytes(key)).equals(bytes)).toBe(true);
    });

    test("cancels mid-upload and tears the multipart upload down", async ({ page }) => {
      await slowParts(page, 700);
      await page.goto(`/${fw}.html?concurrency=1`);
      await choose(page, [{ name: `${fw}-cancel.bin`, buffer: bytesOf(26 * MIB, 13) }]);
      await page.getByTestId("start").click();

      await expect(rows(page).first()).not.toHaveAttribute("data-landed", "0");
      const key = (await rows(page).first().getAttribute("data-key"))!;
      await page.getByTestId("cancel").click();
      await expect(status(page)).toHaveAttribute("data-status", "cancelled");

      await expect.poll(openMultipartKeys).not.toContain(key);
      expect(await exists(key)).toBe(false);
    });

    test("retries parts a flaky network drops, and still finishes", async ({ page }) => {
      const bytes = bytesOf(18 * MIB, 17);
      await page.goto(`/${fw}.html?flaky=1`);
      await choose(page, [{ name: `${fw}-flaky.bin`, buffer: bytes }]);
      await page.getByTestId("start").click();

      await expect(status(page)).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
      await expect(page.getByTestId("log")).toContainText("retrying");
      const key = (await rows(page).first().getAttribute("data-key"))!;
      expect((await storedBytes(key)).equals(bytes)).toBe(true);
    });

    test("uploads several files in one batch", async ({ page }) => {
      await page.goto(`/${fw}.html`);
      await choose(page, [
        { name: `${fw}-a.bin`, buffer: bytesOf(12 * MIB, 19) },
        { name: `${fw}-b.txt`, buffer: bytesOf(40 * 1024, 23), mimeType: "text/plain" },
      ]);
      await page.getByTestId("start").click();

      await expect(status(page)).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
      await expect(rows(page)).toHaveCount(2);
      for (const row of await rows(page).all())
        await expect(row).toHaveAttribute("data-status", "succeeded");
    });
  });
}

test("resumes after a reload, sending only what never landed", async ({ page }) => {
  // A real file on disk, chosen twice: its last-modified time must match for
  // the fingerprint check to accept it, as it does when a user re-selects it.
  const path = join(mkdtempSync(join(tmpdir(), "pmu-")), "reload.bin");
  writeFileSync(path, bytesOf(26 * MIB, 29));

  await slowParts(page, 700);
  await page.goto("/react.html?concurrency=1");
  await page.getByTestId("file-input").setInputFiles(path);
  await page.getByTestId("start").click();
  await expect(rows(page).first()).toHaveAttribute("data-landed", "2", { timeout: 20_000 });

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload();
  const row = page.getByTestId("resume-row").filter({ hasText: "reload.bin" });
  await expect(row).toContainText("2 of 6 parts stored");

  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().includes("partNumber="))
      sent.push(new URL(r.url()).searchParams.get("partNumber")!);
  });
  await row.getByTestId("resume-input").setInputFiles(path);
  await expect(row).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
  expect(sent).not.toContain("1");
  expect(sent).not.toContain("2");
  expect(sent.length).toBeGreaterThan(0);
});
