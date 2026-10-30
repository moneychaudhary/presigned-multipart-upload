import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The library is linked from the parent folder, whose node_modules hold its
    // own dev copies of these. One copy each, or React sees two Reacts.
    dedupe: [
      "react",
      "react-dom",
      "@angular/core",
      "@angular/common",
      "rxjs",
      "@aws-sdk/client-s3",
    ],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://localhost:8787" },
  },
  build: {
    rollupOptions: {
      input: ["index.html", "react.html", "angular.html"],
    },
  },
});
