/**
 * Compile the README's own snippets against the real types.
 *
 * Documentation that no longer matches the code is worse than none, and the
 * README has been rewritten several times against an API that kept moving.
 * Backend examples are skipped — they belong to aws-sdk and boto3, not here.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
// Inside node_modules, so the snippets resolve this repo's packages (the AWS
// SDK for the server examples) the way an adopter's project would.
const dir = mkdtempSync(join(root, "node_modules", ".readme-check-"));
const src = relative(dir, join(root, "src")).replaceAll("\\", "/");

const preamble = `import { createUploader, httpTransport, listResumable, resumeUploader,
  UploaderStatus, UploadEvent, UploadErrorCode,
  type Uploader, type Transport, type UploaderSnapshot } from "${src}/index.js";
import { createIndexedDbStore, scopeStore } from "${src}/advanced.js";
import { useUploader, useUploaderEvent } from "${src}/react.js";
import { createUploadHandler, toNodeHandler } from "${src}/server.js";
import { S3Client } from "@aws-sdk/client-s3";
declare const file: File; declare const files: File[];
declare const transport: Transport; declare const uploader: Uploader;
declare const snapshot: UploaderSnapshot;
declare const askUserToPickAgain: (f: unknown) => Promise<File>;
declare const currentUserId: () => string;
declare const s3: S3Client;
declare const app: { post: (path: string, handler: unknown) => void };
void [createUploader, httpTransport, listResumable, resumeUploader, createIndexedDbStore,
  scopeStore, UploaderStatus, UploadEvent, UploadErrorCode, useUploader, useUploaderEvent,
  createUploadHandler, toNodeHandler, S3Client, file, files, transport, uploader, snapshot,
  askUserToPickAgain, currentUserId, s3, app];
export async function snippet() {
`;

try {
  const md = readFileSync(join(root, "README.md"), "utf8");
  const blocks = [...md.matchAll(/```(tsx?)\n([\s\S]*?)```/g)];
  let written = 0;

  blocks.forEach(([, lang, code], index) => {
    // Backend: aws-sdk calls, which compile against aws-sdk, not this library.
    if (["s3.send(", "Command("].some((marker) => code.includes(marker))) return;
    // A block of nothing but imports is a map of entry points, not runnable code.
    const lines = code.split("\n").filter((line) => line.trim() && !line.trim().startsWith("//"));
    if (lines.every((line) => line.startsWith("import "))) return;
    if (code.includes("@Injectable")) return; // Angular decorators
    // Imports are in the preamble, and snippets run inside a function, where
    // \`export\` (Next.js's \`export const POST\`) is not allowed.
    const body = code
      .split("\n")
      .filter((line) => !line.startsWith("import "))
      .map((line) => line.replace(/^export /, ""))
      .join("\n");
    writeFileSync(join(dir, `block${index}.${lang}`), `${preamble}${body}\n}\n`);
    written += 1;
  });

  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      extends: join(root, "tsconfig.json"),
      compilerOptions: {
        noEmit: true,
        jsx: "react-jsx",
        noUnusedLocals: false,
        noUnusedParameters: false,
        // The README tells readers to install these for showOpenFilePicker;
        // the check assumes they did.
        types: ["wicg-file-system-access", "node"],
        // The snippets compile in a temp dir, so point at the project's @types.
        typeRoots: [join(root, "node_modules/@types")],
      },
      include: ["*.ts", "*.tsx"],
    }),
  );

  execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", join(dir, "tsconfig.json")], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  console.log(`README: ${written} snippets compile against src`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
