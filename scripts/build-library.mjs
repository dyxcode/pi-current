import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "dist", "library-api");
await rm(output, { recursive: true, force: true });
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
execFileSync(process.execPath, [tsc, "--project", join(root, "tsconfig.library.json")], {
  cwd: root,
  stdio: "inherit",
});

const libraryOutput = join(output, "library");
await mkdir(libraryOutput, { recursive: true });
for (const name of ["schema.mjs", "worker.mjs"]) {
  await cp(join(root, "src", "library", name), join(libraryOutput, name));
}
