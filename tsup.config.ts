import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    react: "src/react.ts",
    angular: "src/angular.ts",
    advanced: "src/advanced.ts",
    server: "src/server.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  // Off deliberately. tsup embeds sourcesContent, so maps carried the whole
  // TypeScript source and were 72% of the package — shipping `src` by the back
  // door, for a library whose source is a click away on GitHub.
  sourcemap: false,
  clean: true,
  // On for CommonJS too, not only ESM. Without it each CJS entry inlined its
  // own copy of the Core, so `require(".../react")` threw an UploadError that
  // failed `instanceof` against the one from the main entry, and opened a
  // second IndexedDB connection beside the main entry's.
  splitting: true,
  treeshake: true,
  // Frameworks are optional peers; importing the Core must never pull one in.
  external: ["react", "@angular/core", "rxjs", /^@aws-sdk\//, /^node:/],
});
