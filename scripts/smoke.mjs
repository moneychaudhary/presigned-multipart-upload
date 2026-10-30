/**
 * Install the real tarball into an empty project and use it as a consumer does.
 *
 * The unit suite imports from `src`, so it cannot see the package boundary at
 * all: an empty `dist`, a wrong `exports` condition or a missing file all pass
 * it. Both of those shipped once. This runs after `npm pack` and fails loudly.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const root = process.cwd();
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const dir = mkdtempSync(join(tmpdir(), "pmu-smoke-"));
let failed = false;
const check = (label, fn) => {
  try {
    console.log(`  ok   ${label}${fn() ?? ""}`);
  } catch (error) {
    failed = true;
    console.error(`  FAIL ${label}\n       ${String(error.stdout ?? error.message).trim()}`);
  }
};

try {
  console.log("packing…");
  run("npm", ["pack", "--pack-destination", dir], root);
  const tarball = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack produced no tarball");

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  console.log(`installing ${tarball} into a clean project…`);
  run("npm", ["install", `./${tarball}`, "--silent", "--no-audit", "--no-fund"], dir);

  writeFileSync(
    join(dir, "esm.mjs"),
    `import { createUploader, httpTransport, UploaderStatus, S3_LIMITS } from "presigned-multipart-upload";
     import { httpFailure } from "presigned-multipart-upload/advanced";
     if (typeof createUploader !== "function") throw new Error("createUploader missing");
     if (typeof httpTransport !== "function") throw new Error("httpTransport missing");
     if (httpFailure(503).status !== 503) throw new Error("failure shapes missing");
     if (UploaderStatus.Succeeded !== "succeeded") throw new Error("constants missing");
     if (S3_LIMITS.maxParts !== 10000) throw new Error("S3_LIMITS missing");
     process.stdout.write("");`,
  );
  writeFileSync(
    join(dir, "cjs.cjs"),
    `const { createUploader, UploadError, UploadErrorCode } = require("presigned-multipart-upload");
     if (typeof createUploader !== "function") throw new Error("createUploader missing");
     const e = new UploadError(UploadErrorCode.EmptyFile, "x");
     if (!(e instanceof Error) || e.code !== "EMPTY_FILE") throw new Error("UploadError broken");
     process.stdout.write("");`,
  );

  check("import from ESM", () => run("node", ["esm.mjs"], dir));
  // Each format must carry the Core once. A duplicate means an adapter entry
  // throws UploadErrors that fail instanceof against the main entry's, and opens
  // its own IndexedDB connection. Counted on a marker only the Core contains.
  check("one copy of the Core per format", () => {
    const installed = join(dir, "node_modules", "presigned-multipart-upload", "dist");
    for (const ext of [".js", ".cjs"]) {
      const holders = readdirSync(installed)
        .filter((file) => file.endsWith(ext))
        .filter((file) => readFileSync(join(installed, file), "utf8").includes("indexedDB.open"));
      if (holders.length !== 1)
        throw new Error(`${ext}: the Core is in ${holders.join(", ") || "no file"}`);
    }
    return "";
  });
  check("require from CJS", () => run("node", ["cjs.cjs"], dir));
  check("the advanced entry resolves", () =>
    run(
      "node",
      [
        "--input-type=module",
        "-e",
        'import("presigned-multipart-upload/advanced").then((m) => { if (typeof m.browserPlatform !== "function") throw new Error("advanced entry broken"); })',
      ],
      dir,
    ),
  );
  // What a browser downloads: the main entry and the chunks it shares with the
  // adapters, gzipped. A budget, so growth is a decision rather than a drift.
  check("the browser bundle stays under budget", () => {
    const dist = join(dir, "node_modules", "presigned-multipart-upload", "dist");
    const files = readdirSync(dist).filter((f) => f === "index.js" || /^chunk-.*\.js$/.test(f));
    const bytes = files.reduce((sum, f) => sum + gzipSync(readFileSync(join(dist, f))).length, 0);
    const budget = 20 * 1024;
    if (bytes > budget) throw new Error(`${bytes} bytes gzipped, over the ${budget} budget`);
    return ` (${(bytes / 1024).toFixed(1)} KB gzipped of ${budget / 1024} KB)`;
  });
  check("types resolve in every mode", () => {
    const out = run("npx", ["attw", "--pack", root, "--format", "table-flipped"], root);
    if (/💀|👺|❌/.test(out)) throw new Error(out);
    return "";
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("package smoke test passed");
