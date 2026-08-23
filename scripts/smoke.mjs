/**
 * Install the real tarball into an empty project and use it as a consumer does.
 *
 * The unit suite imports from `src`, so it cannot see the package boundary at
 * all: an empty `dist`, a wrong `exports` condition or a missing file all pass
 * it. Both of those shipped once. This runs after `npm pack` and fails loudly.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    `import { createUploader, httpTransport, UploaderStatus, PROVIDERS } from "presigned-multipart-upload";
     if (typeof createUploader !== "function") throw new Error("createUploader missing");
     if (typeof httpTransport !== "function") throw new Error("httpTransport missing");
     if (UploaderStatus.Succeeded !== "succeeded") throw new Error("constants missing");
     if (PROVIDERS.s3.maxParts !== 10000) throw new Error("PROVIDERS missing");
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
  check("require from CJS", () => run("node", ["cjs.cjs"], dir));
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
