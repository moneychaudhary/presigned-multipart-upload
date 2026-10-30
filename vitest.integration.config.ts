import { defineConfig } from "vitest/config";

/**
 * The integration suite is separate so the default `npm test` needs no
 * container. Run it with `npm run test:integration` once MinIO is up.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
