import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The integration suite needs a running S3-compatible server. It lives
    // behind `npm run test:integration` so the default run stays hermetic.
    exclude: ["test/integration/**"],
  },
});
