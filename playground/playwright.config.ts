import { defineConfig, devices } from "@playwright/test";

/**
 * Drives every framework page in a real browser against S3 on LocalStack.
 * Start LocalStack first (`npm run aws:up`); the backend and Vite are started here.
 */
export default defineConfig({
  testDir: "e2e",
  // Screenshots for the README are a separate run: `npm run screenshots`.
  testIgnore: process.env.SCREENSHOTS ? [] : ["**/screenshots.spec.ts"],
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5173" },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } },
    },
  ],
  webServer: [
    { command: "npm run server", port: 8787, reuseExistingServer: true },
    { command: "npm run web", port: 5173, reuseExistingServer: true },
  ],
});
