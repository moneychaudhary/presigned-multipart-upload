/**
 * Compile the README's own snippets against the real types.
 *
 * Documentation that no longer matches the code is worse than none, and the
 * README has been rewritten several times against an API that kept moving.
 * Backend examples are skipped — they belong to aws-sdk and boto3, not here.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "pmu-readme-"));
const src = relative(dir, join(root, "src")).replaceAll("\\", "/");

const preamble = `import { createUploader, httpTransport, listResumable, resumeUploader,
  createIndexedDbStore, scopeStore, UploaderStatus, UploadEvent, UploadErrorCode,
  type Uploader, type Transport, type UploaderSnapshot } from "${src}/index.js";
import { useUploader, useUploaderEvent } from "${src}/react.js";
declare const file: File; declare const files: File[];
declare const transport: Transport; declare const uploader: Uploader;
declare const snapshot: UploaderSnapshot;
declare const render: (p: number, s: string) => void;
declare const toast: { success: (m: string) => void };
declare const askUserToPickAgain: (f: unknown) => Promise<File>;
declare const user: { id: string };
declare const celebrate: () => void; declare const fixYourCors: () => void;
void [createUploader, httpTransport, listResumable, resumeUploader, createIndexedDbStore,
  scopeStore, UploaderStatus, UploadEvent, UploadErrorCode, useUploader, useUploaderEvent,
  file, files, transport, uploader, snapshot, render, toast, askUserToPickAgain, user,
  celebrate, fixYourCors];
export async function snippet() {
`;

try {
  const md = readFileSync(join(root, "README.md"), "utf8");
  const blocks = [...md.matchAll(/```(tsx?)\n([\s\S]*?)```/g)];
  let written = 0;

  blocks.forEach(([, lang, code], index) => {
    if (code.includes("app.post(") || code.includes("s3.send(")) return; // backend
    if ((code.match(/from "presigned-multipart-upload/g) ?? []).length > 1) return; // import map
    if (code.includes("@Injectable")) return; // Angular decorators
    const body = code
      .split("\n")
      .filter((line) => !line.startsWith("import "))
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
        types: ["wicg-file-system-access"],
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
