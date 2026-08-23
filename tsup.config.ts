import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    react: "src/react.ts",
    angular: "src/angular.ts",
    vue: "src/vue.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  // Off deliberately. tsup embeds sourcesContent, so maps carried the whole
  // TypeScript source and were 72% of the package — shipping `src` by the back
  // door, for a library whose source is a click away on GitHub.
  sourcemap: false,
  clean: true,
  treeshake: true,
  // Frameworks are optional peers; importing the Core must never pull one in.
  external: ["react", "vue", "@angular/core", "rxjs"],
});
