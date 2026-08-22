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
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Frameworks are optional peers; importing the Core must never pull one in.
  external: ["react", "vue", "@angular/core", "rxjs"],
});
