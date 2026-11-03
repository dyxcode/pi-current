import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { feedModule } from "./feed.ts";
import { dataRoot, safeRoot } from "./paths.ts";
import type { SourceModule, SourceRegistration } from "./types.ts";

const manifestName = "source-modules.json";
const moduleExtensions = new Set([".mjs", ".js", ".ts"]);

type StoredModule = { id: string; name: string; modulePath: string };
type StoredManifest = { version: 1; modules: StoredModule[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === "string" && keys.includes(key))
  );
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 80 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Display names must not contain control characters.
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validateModule(value: unknown): SourceModule {
  if (
    !isRecord(value) ||
    !validId(value.id) ||
    !validName(value.name) ||
    typeof value.fetch !== "function"
  ) {
    throw new Error("Invalid source module: expected a valid id, name, and fetch function.");
  }
  return value as unknown as SourceModule;
}

function validateStoredManifest(value: unknown): StoredManifest {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "modules"])) {
    throw new Error("The source modules manifest must contain version and modules fields.");
  }
  if (value.version !== 1 || !Array.isArray(value.modules)) {
    throw new Error(
      "The source modules manifest has an unsupported version or invalid modules list.",
    );
  }
  const ids = new Set<string>([feedModule.id]);
  const modules: StoredModule[] = [];
  for (const entry of value.modules) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["id", "name", "modulePath"]) ||
      !validId(entry.id) ||
      !validName(entry.name) ||
      typeof entry.modulePath !== "string" ||
      !isAbsolute(entry.modulePath) ||
      !moduleExtensions.has(extname(entry.modulePath))
    ) {
      throw new Error("The source modules manifest contains an invalid registration.");
    }
    if (ids.has(entry.id)) {
      throw new Error(`The source modules manifest contains a duplicate source ID: ${entry.id}.`);
    }
    ids.add(entry.id);
    modules.push({ id: entry.id, name: entry.name, modulePath: entry.modulePath });
  }
  return { version: 1, modules };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** Local, trusted source module registrations. Listing never imports modules or calls fetch. */
export class SourceRegistry {
  readonly root: string;
  private mutation: Promise<void> = Promise.resolve();
  private readonly loaded = new Map<string, SourceModule>();

  constructor(options: { root?: string } = {}) {
    this.root = safeRoot(options.root ?? dataRoot());
    this.loaded.set(feedModule.id, validateModule(feedModule));
  }

  private async manifestPath(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error(`Source registry root is not a regular directory: ${this.root}`);
    }
    return join(this.root, manifestName);
  }

  private async readManifest(): Promise<StoredManifest> {
    const path = await this.manifestPath();
    const info = await lstat(path).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw new Error(`Could not inspect ${manifestName}: ${errorMessage(error)}`, {
        cause: error,
      });
    });
    if (!info) return { version: 1, modules: [] };
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`${manifestName} must be a regular file, not a symlink or directory.`);
    }

    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      throw new Error(`Could not read ${manifestName}: ${errorMessage(error)}`, { cause: error });
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(`${manifestName} is not valid JSON: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    return validateStoredManifest(value);
  }

  private async writeManifest(manifest: StoredManifest): Promise<void> {
    const path = await this.manifestPath();
    const temporary = join(this.root, `.${manifestName}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new Error(`Could not write temporary ${manifestName}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    const target = await lstat(path).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw new Error(`Could not inspect ${manifestName}: ${errorMessage(error)}`, {
        cause: error,
      });
    });
    if (target && (!target.isFile() || target.isSymbolicLink())) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new Error(`${manifestName} must be a regular file, not a symlink or directory.`);
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new Error(`Could not replace ${manifestName}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutation;
    let release = () => {};
    this.mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async importModule(modulePath: string): Promise<SourceModule> {
    let namespace: unknown;
    try {
      namespace = await import(pathToFileURL(modulePath).href);
    } catch (error) {
      throw new Error(`Could not load source module ${modulePath}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    const exported = isRecord(namespace) ? namespace.default : undefined;
    try {
      return validateModule(exported);
    } catch (error) {
      throw new Error(`Invalid source module at ${modulePath}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  async list(): Promise<SourceRegistration[]> {
    const { modules } = await this.readManifest();
    return [
      { id: feedModule.id, name: feedModule.name },
      ...modules
        .map(({ id, name, modulePath }) => ({ id, name, modulePath }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ];
  }

  async get(id: string): Promise<SourceModule> {
    if (!validId(id)) throw new Error(`Invalid source ID: ${String(id)}.`);
    if (id === feedModule.id) {
      const builtIn = this.loaded.get(feedModule.id);
      if (!builtIn) throw new Error("The built-in feed source module is unavailable.");
      return builtIn;
    }
    const { modules } = await this.readManifest();
    const registration = modules.find((module) => module.id === id);
    if (!registration) throw new Error(`Unknown source: ${id}.`);
    const cached = this.loaded.get(id);
    if (cached) return cached;

    const module = await this.importModule(registration.modulePath);
    if (module.id !== registration.id) {
      throw new Error(
        `Source module ID changed at ${registration.modulePath}: expected ${registration.id}, received ${module.id}.`,
      );
    }
    this.loaded.set(id, module);
    return module;
  }

  async register(modulePath: string): Promise<SourceRegistration> {
    if (typeof modulePath !== "string" || !isAbsolute(modulePath)) {
      throw new Error("Source module path must be absolute.");
    }
    if (!moduleExtensions.has(extname(modulePath))) {
      throw new Error("Source module path must end in .mjs, .js, or .ts.");
    }
    let resolved: string;
    try {
      resolved = await realpath(modulePath);
      if (!moduleExtensions.has(extname(resolved))) {
        throw new Error("resolved path does not end in .mjs, .js, or .ts");
      }
      const info = await stat(resolved);
      if (!info.isFile()) throw new Error("path is not a regular file");
    } catch (error) {
      throw new Error(`Could not resolve source module ${modulePath}: ${errorMessage(error)}`, {
        cause: error,
      });
    }

    const module = await this.importModule(resolved);
    if (module.id === feedModule.id) {
      throw new Error(`Source ID ${module.id} is already registered by the built-in feed module.`);
    }
    return this.serialize(async () => {
      const manifest = await this.readManifest();
      if (manifest.modules.some((current) => current.id === module.id)) {
        throw new Error(`Source ID ${module.id} is already registered.`);
      }
      const registration = { id: module.id, name: module.name, modulePath: resolved };
      const modules = [...manifest.modules, registration].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      await this.writeManifest({ version: 1, modules });
      this.loaded.set(module.id, module);
      return registration;
    });
  }

  async remove(id: string): Promise<void> {
    if (!validId(id)) throw new Error(`Invalid source ID: ${String(id)}.`);
    if (id === feedModule.id) throw new Error("The built-in source feed cannot be removed.");
    await this.serialize(async () => {
      const manifest = await this.readManifest();
      if (!manifest.modules.some((module) => module.id === id)) {
        throw new Error(`Unknown source: ${id}.`);
      }
      await this.writeManifest({
        version: 1,
        modules: manifest.modules.filter((module) => module.id !== id),
      });
      this.loaded.delete(id);
    });
  }
}
