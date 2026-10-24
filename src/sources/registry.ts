import { lstat, readFile, writeFile, mkdir, rename, rm, realpath } from "node:fs/promises";
import { join, isAbsolute, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { safeRoot } from "./paths.ts";
import {
  PAUSES,
  validId,
  safeCode,
  canonicalUrl,
  validateItem,
  type AuthState,
  type SourceAdapter,
  type SourcePlugin,
  type Registration,
  type SourceState,
  type SourceStatus,
  type Capabilities,
  type SourceBatch,
} from "./types.ts";
const authStates = [
  "not-connected",
  "not-required",
  "unknown",
  "ready",
  "login-required",
  "expired",
  "verification-required",
];
const keys = ["login", "check", "read", "collect"] as const;
function manifest(input: unknown): SourcePlugin {
  if (!input || typeof input !== "object") throw new Error("PLUGIN_INVALID");
  const p = input as SourcePlugin;
  validId(p.id);
  if (
    p.apiVersion !== 1 ||
    typeof p.name !== "string" ||
    !p.name.trim() ||
    p.name.length > 80 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Source display names must not contain control characters.
    /[\u0000-\u001f\u007f]/.test(p.name) ||
    typeof p.create !== "function" ||
    !p.capabilities ||
    keys.some((k) => typeof p.capabilities[k] !== "boolean") ||
    Object.keys(p.capabilities).some((k) => !keys.some((key) => key === k)) ||
    !Array.isArray(p.hosts) ||
    p.hosts.length > 20 ||
    p.hosts.some((h) => typeof h !== "string" || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(h)) ||
    (p.capabilities.read && !p.hosts.length)
  )
    throw new Error("PLUGIN_INVALID");
  return p;
}
async function load(path: string): Promise<SourcePlugin> {
  if (!isAbsolute(path) || ![".mjs", ".js", ".ts"].includes(extname(path)))
    throw new Error("PLUGIN_INVALID");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 256 * 1024) throw new Error("PLUGIN_INVALID");
    const hash = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    const module: unknown = await abortable(
      import(`${pathToFileURL(path).href}?revision=${hash}`),
      AbortSignal.timeout(5000),
    );
    return manifest(
      module && typeof module === "object" && "default" in module ? module.default : undefined,
    );
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message === "PLUGIN_INVALID"
        ? "PLUGIN_INVALID"
        : "PLUGIN_LOAD_FAILED",
    );
  }
}
async function readJson(path: string, fallback: unknown): Promise<unknown> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error();
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error("REGISTRY_INVALID");
  }
}
async function atomic(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch {
    throw new Error("STATE_IO_ERROR");
  } finally {
    await rm(temporary, { force: true });
  }
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  try {
    if (signal.aborted) throw new Error("CANCELLED");
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("CANCELLED"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
export class SourceRegistry {
  readonly root: string;
  private readonly adapters = new Map<string, SourceAdapter>();
  private readonly active = new Map<string, AbortController>();
  private closed = false;
  private readonly timeoutMs: number;
  constructor(options: {
    root: string;
    timeoutMs?: number;
  }) {
    this.root = safeRoot(options.root);
    this.timeoutMs = options.timeoutMs ?? 45000;
  }
  private async directory(name: string): Promise<string> {
    const path = join(this.root, name);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error("STATE_IO_ERROR");
    return path;
  }
  private async records(): Promise<Registration[]> {
    const value = await readJson(join(this.root, "source-registry.json"), {
      version: 1,
      sources: [],
    });
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 1 ||
      !("sources" in value) ||
      !Array.isArray(value.sources) ||
      value.sources.length > 32
    )
      throw new Error("REGISTRY_INVALID");
    const ids = new Set();
    for (const row of value.sources) {
      try {
        manifest({ ...row, apiVersion: 1, create: async () => ({}) });
      } catch {
        throw new Error("REGISTRY_INVALID");
      }
      if (
        typeof row.modulePath !== "string" ||
        !isAbsolute(row.modulePath) ||
        typeof row.enabled !== "boolean" ||
        ids.has(row.id)
      )
        throw new Error("REGISTRY_INVALID");
      ids.add(row.id);
    }
    return value.sources as Registration[];
  }
  private async mutate(change: (rows: Registration[]) => Promise<Registration[]>): Promise<void> {
    if (this.closed) throw new Error("CANCELLED");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, "source-registry.lock");
    try {
      await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch {
      throw new Error("SOURCE_BUSY");
    }
    try {
      await atomic(join(this.root, "source-registry.json"), {
        version: 1,
        sources: await change(await this.records()),
      });
    } finally {
      await rm(lock, { force: true });
    }
  }
  private async state(row: Registration): Promise<SourceState> {
    const initial: SourceState = {
      auth: row.capabilities.login ? "not-connected" : "not-required",
    };
    const value = await readJson(join(this.root, "source-state", `${row.id}.json`), initial);
    if (!value || typeof value !== "object") throw new Error("REGISTRY_INVALID");
    const s = value as SourceState;
    if (
      !authStates.includes(s.auth) ||
      (s.checkedAt !== undefined && !Number.isFinite(Date.parse(s.checkedAt))) ||
      (s.problem !== undefined && !/^[A-Z_]{1,50}$/.test(s.problem)) ||
      (s.pause !== undefined && !PAUSES.some((p) => p === s.pause))
    )
      throw new Error("REGISTRY_INVALID");
    return {
      auth: s.auth,
      ...(s.checkedAt ? { checkedAt: s.checkedAt } : {}),
      ...(s.problem ? { problem: s.problem } : {}),
      ...(s.pause ? { pause: s.pause } : {}),
    };
  }
  private async saveState(id: string, state: SourceState) {
    await atomic(join(await this.directory("source-state"), `${id}.json`), state);
  }
  private async plugin(row: Registration) {
    const p = await load(row.modulePath);
    if (
      p.id !== row.id ||
      p.name !== row.name ||
      JSON.stringify(p.capabilities) !== JSON.stringify(row.capabilities) ||
      JSON.stringify(p.hosts) !== JSON.stringify(row.hosts)
    )
      throw new Error("PLUGIN_CHANGED");
    return p;
  }
  async list(): Promise<SourceStatus[]> {
    const result: SourceStatus[] = [];
    for (const row of await this.records()) {
      try {
        const state = await this.state(row);
        await this.plugin(row);
        result.push({ ...row, ...state });
      } catch (error) {
        result.push({ ...row, auth: "unknown", problem: safeCode(error) });
      }
    }
    return result;
  }
  async register(path: string): Promise<void> {
    if (this.closed) throw new Error("CANCELLED");
    if (!isAbsolute(path)) throw new Error("PLUGIN_INVALID");
    let modulePath: string;
    try {
      modulePath = await realpath(path);
    } catch {
      throw new Error("PLUGIN_LOAD_FAILED");
    }
    const p = await load(modulePath);
    await this.mutate(async (rows) => {
      if (rows.some((r) => r.id === p.id)) throw new Error("SOURCE_ALREADY_REGISTERED");
      if (rows.length >= 32) throw new Error("REGISTRY_INVALID");
      return [
        ...rows,
        {
          id: p.id,
          name: p.name,
          modulePath,
          capabilities: p.capabilities,
          hosts: p.hosts,
          enabled: true,
        },
      ];
    });
  }
  private async drop(id: string) {
    this.active.get(id)?.abort();
    const adapter = this.adapters.get(id);
    this.adapters.delete(id);
    if (adapter)
      try {
        await abortable(
          Promise.resolve().then(() => adapter.close()),
          AbortSignal.timeout(5000),
        );
      } catch {
        throw new Error("PLUGIN_CLOSE_FAILED");
      }
  }
  async remove(id: string) {
    validId(id);
    await this.mutate(async (rows) => {
      if (!rows.some((r) => r.id === id)) throw new Error("SOURCE_NOT_FOUND");
      await this.drop(id);
      return rows.filter((r) => r.id !== id);
    });
  }
  async setEnabled(id: string, enabled: boolean) {
    validId(id);
    await this.mutate(async (rows) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error("SOURCE_NOT_FOUND");
      if (!enabled) await this.drop(id);
      return rows.map((r) => (r.id === id ? { ...r, enabled } : r));
    });
  }
  async resolve(url: string, sourceId?: string): Promise<string> {
    const host = new URL(canonicalUrl(url)).hostname;
    const rows = (await this.records()).filter(
      (r) =>
        r.capabilities.read && r.hosts.includes(host) && (sourceId ? r.id === sourceId : r.enabled),
    );
    if (!rows.length) throw new Error("SOURCE_NOT_FOUND");
    if (rows.length > 1) throw new Error("SOURCE_AMBIGUOUS");
    return rows[0]!.id;
  }
  private async run<T>(
    id: string,
    capability: keyof Capabilities,
    operation: (adapter: SourceAdapter, signal: AbortSignal, row: Registration) => Promise<T>,
    caller?: AbortSignal,
  ): Promise<T> {
    validId(id);
    if (this.closed || caller?.aborted) throw new Error("CANCELLED");
    if (this.active.has(id)) throw new Error("SOURCE_BUSY");
    const controller = new AbortController();
    this.active.set(id, controller);
    const deadline = AbortSignal.timeout(capability === "collect" ? 180000 : this.timeoutMs);
    const signal = AbortSignal.any([controller.signal, deadline, ...(caller ? [caller] : [])]);
    let state: SourceState | undefined;
    try {
      const row = (await this.records()).find((r) => r.id === id);
      if (!row) throw new Error("SOURCE_NOT_FOUND");
      if (!row.enabled) throw new Error("SOURCE_DISABLED");
      if (!row.capabilities[capability]) throw new Error("SOURCE_CAPABILITY_UNAVAILABLE");
      state = await this.state(row);
      if (state.pause && ["read", "collect"].includes(capability)) throw new Error(state.pause);
      const plugin = await this.plugin(row);
      let adapter = this.adapters.get(id);
      if (!adapter) {
        const dataDir = join(await this.directory("source-data"), id);
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        if ((await lstat(dataDir)).isSymbolicLink()) throw new Error("STATE_IO_ERROR");
        const creating = Promise.resolve().then(() => plugin.create({ sourceId: id, dataDir }));
        void creating.then(
          (value) => {
            if (signal.aborted)
              void Promise.resolve()
                .then(() => value.close())
                .catch(() => {});
          },
          () => {},
        );
        adapter = await abortable(creating, signal);
        if (
          !adapter ||
          typeof adapter.close !== "function" ||
          keys.some((k) => row.capabilities[k] !== (typeof adapter![k] === "function"))
        ) {
          if (adapter && typeof adapter.close === "function")
            try {
              await abortable(
                Promise.resolve().then(() => adapter!.close()),
                AbortSignal.timeout(5000),
              );
            } catch {}
          throw new Error("PLUGIN_INVALID");
        }
        this.adapters.set(id, adapter);
      }
      const result = await abortable(
        Promise.resolve().then(() => operation(adapter!, signal, row)),
        signal,
      );
      if (signal.aborted) throw new Error("CANCELLED");
      return result;
    } catch (error) {
      const code = deadline.aborted ? "TIMEOUT" : signal.aborted ? "CANCELLED" : safeCode(error);
      if (state && !signal.aborted) {
        const next = { ...state, problem: code, checkedAt: new Date().toISOString() };
        if (PAUSES.some((p) => p === code)) next.pause = code;
        if (code === "LOGIN_REQUIRED")
          next.auth = state.auth === "ready" ? "expired" : "login-required";
        if (code === "VERIFICATION_REQUIRED") next.auth = "verification-required";
        await this.saveState(id, next);
      }
      throw new Error(code);
    } finally {
      if (this.active.get(id) === controller) this.active.delete(id);
    }
  }
  async login(id: string, signal?: AbortSignal): Promise<void> {
    return this.run(
      id,
      "login",
      async (a, s, row) => {
        await a.login!(s);
        if (s.aborted) throw new Error("CANCELLED");
        const state = await this.state(row);
        delete state.problem;
        await this.saveState(id, { ...state, auth: "unknown" });
      },
      signal,
    );
  }
  async check(id: string, signal?: AbortSignal): Promise<AuthState> {
    return this.run(
      id,
      "check",
      async (a, s, row) => {
        const auth = await a.check!(s);
        if (s.aborted) throw new Error("CANCELLED");
        if (!authStates.includes(auth)) throw new Error("SOURCE_INVALID_RESULT");
        const state = await this.state(row);
        const next = { ...state, auth, checkedAt: new Date().toISOString() };
        if (auth === "ready" || auth === "not-required") {
          delete next.problem;
          delete next.pause;
        }
        if (auth === "verification-required") {
          next.pause = "VERIFICATION_REQUIRED";
          next.problem = "VERIFICATION_REQUIRED";
        }
        if (auth === "login-required" || auth === "expired") next.problem = "LOGIN_REQUIRED";
        await this.saveState(id, next);
        return auth;
      },
      signal,
    );
  }
  async read(id: string, url: string, maxCharacters: number, signal?: AbortSignal) {
    const canonical = canonicalUrl(url);
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1000 || maxCharacters > 50000)
      throw new Error("SOURCE_INVALID_INPUT");
    return this.run(
      id,
      "read",
      async (a, s, row) => {
        if (!row.hosts.includes(new URL(canonical).hostname))
          throw new Error("SOURCE_URL_MISMATCH");
        const item = await a.read!(canonical, maxCharacters, s);
        validateItem(item, id, maxCharacters);
        if (canonicalUrl(item.url) !== canonical) throw new Error("SOURCE_INVALID_RESULT");
        return item;
      },
      signal,
    );
  }
  async collect(id: string, limit: number, signal?: AbortSignal): Promise<SourceBatch> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new Error("SOURCE_INVALID_INPUT");
    return this.run(
      id,
      "collect",
      async (a, s, row) => {
        const batch = await a.collect!(limit, s);
        if (
          !batch ||
          !Array.isArray(batch.items) ||
          batch.items.length > limit ||
          !Array.isArray(batch.failures) ||
          batch.failures.length > 1 ||
          typeof batch.stopReason !== "string" ||
          !/^[a-zA-Z_-]{1,50}$/.test(batch.stopReason)
        )
          throw new Error("SOURCE_INVALID_RESULT");
        const ids = new Set();
        let size = 0;
        for (const item of batch.items) {
          validateItem(item, id, 5000);
          if (!row.hosts.includes(new URL(item.url).hostname) || ids.has(item.externalId))
            throw new Error("SOURCE_INVALID_RESULT");
          ids.add(item.externalId);
          size += [...item.text].length;
        }
        if (size > 25000) throw new Error("SOURCE_INVALID_RESULT");
        for (const failure of batch.failures)
          if (
            typeof failure.externalId !== "string" ||
            failure.externalId.length > 256 ||
            typeof failure.code !== "string" ||
            safeCode(new Error(failure.code)) !== failure.code
          )
            throw new Error("SOURCE_INVALID_RESULT");
        if (batch.failures.length) batch.stopReason = batch.failures[0]!.code;
        if (
          !["limit", "text-budget", "no-new-items", "scroll-budget", "complete"].includes(
            batch.stopReason,
          )
        ) {
          const state = await this.state(row);
          const code = safeCode(new Error(batch.stopReason));
          batch.stopReason = code;
          if (!s.aborted)
            await this.saveState(id, {
              ...state,
              problem: code,
              checkedAt: new Date().toISOString(),
              ...(PAUSES.some((p) => p === code) ? { pause: code } : {}),
            });
        }
        return batch;
      },
      signal,
    );
  }
  async close() {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.adapters.keys()].map((id) => this.drop(id)));
  }
}
