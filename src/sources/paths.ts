import { lstatSync, realpathSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
export function dataRoot(): string {
  return process.platform === "darwin"
    ? join(homedir(), "Library/Application Support/pi-current")
    : join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "pi-current");
}
export function safeRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error("STATE_IO_ERROR");
  let base = resolve(root);
  const missing: string[] = [];
  while (!existsSync(base)) {
    missing.unshift(base.slice(dirname(base).length + 1));
    base = dirname(base);
  }
  const result = resolve(realpathSync(base), ...missing);
  let cursor = result;
  while (true) {
    if (existsSync(cursor) && !lstatSync(cursor).isDirectory()) throw new Error("STATE_IO_ERROR");
    if (existsSync(join(cursor, ".git")) || existsSync(join(cursor, ".obsidian")))
      throw new Error("STATE_IO_ERROR");
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return result;
}
