import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { safeRoot } from "./paths.ts";
import { MAX_BATCH_BYTES } from "./content-limits.mjs";
import {
  type AuthState,
  type Capabilities,
  type ConnectionState,
  canonicalUrl,
  ERROR_CODES,
  PAUSES,
  type Registration,
  type SourceAdapter,
  type SourceBatch,
  type SourceDiscoveryBatch,
  type SourceOperationRequest,
  type SourceOperationResult,
  type SourceOperationSpec,
  type SourcePlugin,
  type SourceState,
  type SourceStatus,
  safeCode,
  validateItem,
  validId,
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
const operationKinds = ["discover", "read", "acquire"] as const;
const routeStateKeys = ["auth", "checkedAt", "problem", "pause"] as const;
const nonConnectionFailures = [
  "SOURCE_INVALID_INPUT",
  "SOURCE_CAPABILITY_UNAVAILABLE",
  "SOURCE_URL_MISMATCH",
] as const;
const resultStopReasons = [
  "limit",
  "text-budget",
  "no-new-items",
  "scroll-budget",
  "complete",
  "one-page",
  "page-limit",
  "summary-budget",
  "request-budget",
];
type OperationRoute = { primary: string; required: string[] };
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    value.length <= 80 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Display names must not contain control characters.
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function validStateFields(value: unknown): value is ConnectionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    exactKeys(state, routeStateKeys) &&
    authStates.includes(state.auth as (typeof authStates)[number]) &&
    (state.checkedAt === undefined ||
      (typeof state.checkedAt === "string" && Number.isFinite(Date.parse(state.checkedAt)))) &&
    (state.problem === undefined ||
      (typeof state.problem === "string" && /^[A-Z_]{1,50}$/.test(state.problem))) &&
    (state.pause === undefined ||
      (typeof state.pause === "string" && PAUSES.some((pause) => pause === state.pause)))
  );
}
function routeFailure(error: unknown, allowed: readonly string[], fallback: string): string {
  if (error && typeof error === "object") {
    const field = Object.getOwnPropertyDescriptor(error, "connection");
    if (
      field &&
      "value" in field &&
      typeof field.value === "string" &&
      allowed.includes(field.value)
    )
      return field.value;
  }
  return fallback;
}
function taggedRouteError(code: string, connection: string): Error {
  const error = new Error(code);
  Object.defineProperty(error, "connection", { value: connection });
  return error;
}
function applyConnectionFailure(
  previous: ConnectionState,
  code: string,
  checkedAt: string,
): ConnectionState {
  const next: ConnectionState = { ...previous, problem: code, checkedAt };
  if (PAUSES.some((pause) => pause === code)) next.pause = code;
  if (code === "LOGIN_REQUIRED")
    next.auth = previous.auth === "ready" ? "expired" : "login-required";
  if (code === "VERIFICATION_REQUIRED") next.auth = "verification-required";
  return next;
}
function manifest(input: unknown): SourcePlugin {
  if (!input || typeof input !== "object") throw new Error("PLUGIN_INVALID");
  const p = input as SourcePlugin;
  validId(p.id);
  if (
    p.apiVersion !== 1 ||
    !validName(p.name) ||
    typeof p.create !== "function" ||
    !p.capabilities ||
    keys.some((k) => typeof p.capabilities[k] !== "boolean") ||
    Object.keys(p.capabilities).some((k) => !keys.some((key) => key === k)) ||
    !Array.isArray(p.hosts) ||
    p.hosts.length > 20 ||
    p.hosts.some((h) => typeof h !== "string" || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(h)) ||
    ((p.capabilities.read || (p.operations?.length ?? 0) > 0) && !p.hosts.length)
  )
    throw new Error("PLUGIN_INVALID");
  const connectionIds = new Set<string>();
  if (p.connections !== undefined) {
    if (!Array.isArray(p.connections) || p.connections.length > 20)
      throw new Error("PLUGIN_INVALID");
    for (const connection of p.connections) {
      if (
        !connection ||
        typeof connection !== "object" ||
        !exactKeys(connection as unknown as Record<string, unknown>, [
          "id",
          "name",
          "login",
          "check",
        ])
      )
        throw new Error("PLUGIN_INVALID");
      validId(connection.id);
      if (
        !validName(connection.name) ||
        typeof connection.login !== "boolean" ||
        typeof connection.check !== "boolean" ||
        connectionIds.has(connection.id)
      )
        throw new Error("PLUGIN_INVALID");
      connectionIds.add(connection.id);
    }
  }
  if (p.operations !== undefined) {
    if (!Array.isArray(p.operations) || p.operations.length > 32) throw new Error("PLUGIN_INVALID");
    const operationIds = new Set<string>();
    for (const operation of p.operations) {
      if (
        !operation ||
        typeof operation !== "object" ||
        !exactKeys(operation as unknown as Record<string, unknown>, [
          "id",
          "name",
          "kind",
          "connection",
          "connections",
          "input",
        ])
      )
        throw new Error("PLUGIN_INVALID");
      validId(operation.id);
      validId(operation.connection);
      if (
        !validName(operation.name) ||
        !operationKinds.some((kind) => kind === operation.kind) ||
        !connectionIds.has(operation.connection) ||
        operationIds.has(operation.id) ||
        (operation.input !== undefined &&
          operation.input !== "query" &&
          operation.input !== "url") ||
        (operation.kind === "read" && operation.input !== "url")
      )
        throw new Error("PLUGIN_INVALID");
      operationIds.add(operation.id);
      if (operation.connections !== undefined) {
        if (!Array.isArray(operation.connections) || operation.connections.length > 20)
          throw new Error("PLUGIN_INVALID");
        const required = new Set<string>();
        for (const connection of operation.connections) {
          validId(connection);
          if (!connectionIds.has(connection) || required.has(connection))
            throw new Error("PLUGIN_INVALID");
          required.add(connection);
        }
        if (!required.has(operation.connection)) throw new Error("PLUGIN_INVALID");
      }
    }
  }
  return p;
}
function validateOperationRequest(value: unknown): asserts value is SourceOperationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SOURCE_INVALID_INPUT");
  const request = value as Record<string, unknown>;
  if (
    !exactKeys(request, ["limit", "maxRequests", "maxCharacters", "query", "url"]) ||
    !Number.isInteger(request.limit) ||
    Number(request.limit) < 1 ||
    Number(request.limit) > 10 ||
    !Number.isInteger(request.maxRequests) ||
    Number(request.maxRequests) < 1 ||
    Number(request.maxRequests) > 20 ||
    !Number.isInteger(request.maxCharacters) ||
    Number(request.maxCharacters) < 1000 ||
    Number(request.maxCharacters) > 50000 ||
    (request.query !== undefined &&
      (typeof request.query !== "string" ||
        !request.query.trim() ||
        request.query.length > 2000 ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Operation queries must not contain control characters.
        /[\u0000-\u001f\u007f]/.test(request.query))) ||
    (request.url !== undefined && typeof request.url !== "string") ||
    (request.query !== undefined && request.url !== undefined)
  )
    throw new Error("SOURCE_INVALID_INPUT");
  if (request.url !== undefined) canonicalUrl(request.url as string);
}
function validateOperationInput(spec: SourceOperationSpec, request: SourceOperationRequest) {
  if (
    (spec.input === "query" && (request.query === undefined || request.url !== undefined)) ||
    (spec.input === "url" && (request.url === undefined || request.query !== undefined)) ||
    (spec.input === undefined && (request.query !== undefined || request.url !== undefined)) ||
    (spec.kind === "read" && request.limit !== 1)
  )
    throw new Error("SOURCE_INVALID_INPUT");
}
function resultUrl(value: unknown, hosts: readonly string[]): string {
  if (typeof value !== "string") throw new Error("SOURCE_INVALID_RESULT");
  let canonical: string;
  try {
    canonical = canonicalUrl(value);
  } catch {
    throw new Error("SOURCE_INVALID_RESULT");
  }
  if (!hosts.includes(new URL(canonical).hostname)) throw new Error("SOURCE_INVALID_RESULT");
  return canonical;
}
function validStopReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (resultStopReasons.includes(value) || ERROR_CODES.some((code) => code === value))
  );
}
function validateDiscoveryBatch(
  value: unknown,
  sourceId: string,
  hosts: readonly string[],
  request: SourceOperationRequest,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SOURCE_INVALID_RESULT");
  const batch = value as Record<string, unknown>;
  if (
    !exactKeys(batch, ["items", "stopReason"]) ||
    !Array.isArray(batch.items) ||
    batch.items.length > request.limit ||
    !validStopReason(batch.stopReason)
  )
    throw new Error("SOURCE_INVALID_RESULT");
  const ids = new Set<string>();
  let summaryCharacters = 0;
  for (const item of batch.items) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("SOURCE_INVALID_RESULT");
    const discovery = item as Record<string, unknown>;
    if (
      !exactKeys(discovery, [
        "sourceId",
        "externalId",
        "url",
        "title",
        "summary",
        "contentType",
        "discoveredAt",
        "observedPosition",
      ]) ||
      discovery.sourceId !== sourceId ||
      typeof discovery.externalId !== "string" ||
      !discovery.externalId ||
      discovery.externalId.length > 256 ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: External item IDs must not contain control characters.
      /[\u0000-\u001f]/.test(discovery.externalId) ||
      typeof discovery.title !== "string" ||
      !discovery.title.trim() ||
      discovery.title.length > 2000 ||
      typeof discovery.summary !== "string" ||
      [...discovery.summary].length > Math.min(request.maxCharacters, 5000) ||
      typeof discovery.contentType !== "string" ||
      !discovery.contentType.trim() ||
      discovery.contentType.length > 200 ||
      typeof discovery.discoveredAt !== "string" ||
      !Number.isFinite(Date.parse(discovery.discoveredAt)) ||
      (discovery.observedPosition !== undefined &&
        (!Number.isInteger(discovery.observedPosition) ||
          Number(discovery.observedPosition) < 1)) ||
      ids.has(discovery.externalId)
    )
      throw new Error("SOURCE_INVALID_RESULT");
    resultUrl(discovery.url, hosts);
    ids.add(discovery.externalId);
    summaryCharacters += [...discovery.summary].length;
  }
  if (summaryCharacters > 25000) throw new Error("SOURCE_INVALID_RESULT");
}
function validateContentBatch(
  value: unknown,
  sourceId: string,
  hosts: readonly string[],
  request: SourceOperationRequest,
  kind: SourceOperationSpec["kind"],
): SourceBatch {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SOURCE_INVALID_RESULT");
  const batch = value as Record<string, unknown>;
  if (
    !exactKeys(batch, ["items", "failures", "stopReason"]) ||
    !Array.isArray(batch.items) ||
    batch.items.length > request.limit ||
    (kind === "read" && batch.items.length !== 1) ||
    !Array.isArray(batch.failures) ||
    batch.failures.length > 1 ||
    !validStopReason(batch.stopReason)
  )
    throw new Error("SOURCE_INVALID_RESULT");
  const ids = new Set<string>();
  let bytes = 0;
  for (const item of batch.items) {
    validateItem(item, sourceId);
    const article = item as SourceBatch["items"][number];
    resultUrl(article.url, hosts);
    if (ids.has(article.externalId)) throw new Error("SOURCE_INVALID_RESULT");
    ids.add(article.externalId);
    bytes += Buffer.byteLength(article.text, "utf8");
  }
  if (bytes > MAX_BATCH_BYTES) throw new Error("SOURCE_INVALID_RESULT");
  for (const failure of batch.failures) {
    if (!failure || typeof failure !== "object" || Array.isArray(failure))
      throw new Error("SOURCE_INVALID_RESULT");
    const entry = failure as Record<string, unknown>;
    if (
      !exactKeys(entry, ["externalId", "code"]) ||
      typeof entry.externalId !== "string" ||
      !entry.externalId ||
      entry.externalId.length > 256 ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: External item IDs must not contain control characters.
      /[\u0000-\u001f]/.test(entry.externalId) ||
      typeof entry.code !== "string" ||
      safeCode(new Error(entry.code)) !== entry.code
    )
      throw new Error("SOURCE_INVALID_RESULT");
    if (ids.has(entry.externalId)) throw new Error("SOURCE_INVALID_RESULT");
    ids.add(entry.externalId);
  }
  return batch as unknown as SourceBatch;
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
  private readonly reservations = new Map<string, symbol>();
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
  private reserve(id: string, caller?: AbortSignal): symbol {
    validId(id);
    if (this.closed || caller?.aborted) throw new Error("CANCELLED");
    if (this.active.has(id) || this.reservations.has(id)) throw new Error("SOURCE_BUSY");
    const reservation = Symbol(id);
    this.reservations.set(id, reservation);
    return reservation;
  }
  private releaseReservation(id: string, reservation: symbol) {
    if (this.reservations.get(id) === reservation) this.reservations.delete(id);
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
    const value = await readJson(join(this.root, "source-state", `${row.id}.json`), undefined);
    const persisted = value !== undefined;
    const s = (persisted ? value : initial) as SourceState;
    if (!s || typeof s !== "object") throw new Error("REGISTRY_INVALID");
    if (
      !authStates.includes(s.auth) ||
      (s.checkedAt !== undefined && !Number.isFinite(Date.parse(s.checkedAt))) ||
      (s.problem !== undefined && !/^[A-Z_]{1,50}$/.test(s.problem)) ||
      (s.pause !== undefined && !PAUSES.some((p) => p === s.pause)) ||
      (s.connections !== undefined &&
        (!s.connections || typeof s.connections !== "object" || Array.isArray(s.connections)))
    )
      throw new Error("REGISTRY_INVALID");
    const connectionIds = new Set((row.connections ?? []).map((connection) => connection.id));
    const connectionStates: Record<string, ConnectionState> = {};
    for (const [id, connectionState] of Object.entries(s.connections ?? {})) {
      if (connectionIds.has(id) && !validStateFields(connectionState))
        throw new Error("REGISTRY_INVALID");
    }
    for (const connection of row.connections ?? []) {
      const saved = s.connections?.[connection.id];
      if (saved) {
        connectionStates[connection.id] = {
          auth: saved.auth,
          ...(saved.checkedAt ? { checkedAt: saved.checkedAt } : {}),
          ...(saved.problem ? { problem: saved.problem } : {}),
          ...(saved.pause ? { pause: saved.pause } : {}),
        };
      } else if (persisted) {
        const hasNegativeAuth = ["login-required", "expired", "verification-required"].includes(
          s.auth,
        );
        const inheritedAuth =
          s.auth === "ready" || s.auth === "not-required"
            ? connection.login
              ? "unknown"
              : "not-required"
            : s.auth;
        connectionStates[connection.id] = {
          auth: inheritedAuth,
          ...(hasNegativeAuth && s.checkedAt ? { checkedAt: s.checkedAt } : {}),
          ...(s.problem ? { problem: s.problem } : {}),
          ...(s.pause ? { pause: s.pause } : {}),
        };
      } else {
        connectionStates[connection.id] = {
          auth: connection.login ? "not-connected" : "not-required",
        };
      }
    }
    return {
      auth: s.auth,
      ...(s.checkedAt ? { checkedAt: s.checkedAt } : {}),
      ...(s.problem ? { problem: s.problem } : {}),
      ...(s.pause ? { pause: s.pause } : {}),
      ...(row.connections?.length ? { connections: connectionStates } : {}),
    };
  }
  private async saveState(id: string, state: SourceState) {
    await atomic(join(await this.directory("source-state"), `${id}.json`), state);
  }
  private async saveConnectionFailure(
    id: string,
    connection: string,
    code: string,
    existing?: SourceState,
  ) {
    if (nonConnectionFailures.some((failure) => failure === code)) return;
    let state = existing;
    if (!state) {
      const row = (await this.records()).find((entry) => entry.id === id);
      if (!row) throw new Error("SOURCE_NOT_FOUND");
      state = await this.state(row);
    }
    const previous = state.connections?.[connection];
    if (!previous) throw new Error("REGISTRY_INVALID");
    const next = applyConnectionFailure(previous, code, new Date().toISOString());
    await this.saveState(id, {
      ...state,
      connections: { ...state.connections, [connection]: next },
    });
  }
  private async saveLegacyFailure(id: string, code: string, state: SourceState) {
    const checkedAt = new Date().toISOString();
    const next: SourceState = { ...state, problem: code, checkedAt };
    if (PAUSES.some((pause) => pause === code)) next.pause = code;
    if (code === "LOGIN_REQUIRED")
      next.auth = state.auth === "ready" ? "expired" : "login-required";
    if (code === "VERIFICATION_REQUIRED") next.auth = "verification-required";

    if (PAUSES.some((pause) => pause === code) || code === "LOGIN_REQUIRED") {
      const row = (await this.records()).find((entry) => entry.id === id);
      if (!row) throw new Error("SOURCE_NOT_FOUND");
      if (row.connections?.length) {
        const connections = { ...state.connections };
        for (const connection of row.connections) {
          const previous = connections[connection.id];
          if (!previous) throw new Error("REGISTRY_INVALID");
          connections[connection.id] = applyConnectionFailure(previous, code, checkedAt);
        }
        next.connections = connections;
      }
    }
    await this.saveState(id, next);
  }
  private async plugin(row: Registration) {
    const p = await load(row.modulePath);
    if (
      p.id !== row.id ||
      p.name !== row.name ||
      JSON.stringify(p.capabilities) !== JSON.stringify(row.capabilities) ||
      JSON.stringify(p.hosts) !== JSON.stringify(row.hosts) ||
      JSON.stringify(p.connections ?? []) !== JSON.stringify(row.connections ?? []) ||
      JSON.stringify(p.operations ?? []) !== JSON.stringify(row.operations ?? [])
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
        const { connections: connectionStates, ...sourceState } = state;
        result.push({
          ...row,
          ...sourceState,
          ...(row.connections?.length && connectionStates ? { connectionStates } : {}),
        });
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
          ...(p.connections ? { connections: p.connections } : {}),
          ...(p.operations ? { operations: p.operations } : {}),
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
        (r.capabilities.read ||
          r.operations?.some(
            (operation) => operation.id === "read" && operation.kind === "read",
          )) &&
        r.hosts.includes(host) &&
        (sourceId ? r.id === sourceId : r.enabled),
    );
    if (!rows.length) throw new Error("SOURCE_NOT_FOUND");
    if (rows.length > 1) throw new Error("SOURCE_AMBIGUOUS");
    return rows[0]!.id;
  }
  private async operationRoute(id: string, operation: string) {
    validId(id);
    validId(operation);
    const row = (await this.records()).find((entry) => entry.id === id);
    if (!row) throw new Error("SOURCE_NOT_FOUND");
    const spec = row.operations?.find((entry) => entry.id === operation);
    if (!spec) throw new Error("SOURCE_CAPABILITY_UNAVAILABLE");
    return {
      row,
      spec,
      route: { primary: spec.connection, required: spec.connections ?? [spec.connection] },
    };
  }
  private async recordOperationStop(id: string, connection: string, stopReason: string) {
    if (!resultStopReasons.includes(stopReason) && safeCode(new Error(stopReason)) === stopReason)
      await this.saveConnectionFailure(id, connection, stopReason);
  }
  private async run<T>(
    id: string,
    capability: keyof Capabilities | "perform" | "connection",
    operation: (adapter: SourceAdapter, signal: AbortSignal, row: Registration) => Promise<T>,
    caller?: AbortSignal,
    route?: OperationRoute,
    operationTimeoutMs?: number,
    reservation?: symbol,
  ): Promise<T> {
    validId(id);
    if (this.closed || caller?.aborted) throw new Error("CANCELLED");
    if (
      this.active.has(id) ||
      (this.reservations.has(id) && this.reservations.get(id) !== reservation)
    )
      throw new Error("SOURCE_BUSY");
    if (reservation && this.reservations.get(id) !== reservation) throw new Error("CANCELLED");
    const controller = new AbortController();
    this.active.set(id, controller);
    if (reservation) this.releaseReservation(id, reservation);
    const deadline = AbortSignal.timeout(
      operationTimeoutMs ?? (capability === "collect" ? 180000 : this.timeoutMs),
    );
    const signal = AbortSignal.any([controller.signal, deadline, ...(caller ? [caller] : [])]);
    let state: SourceState | undefined;
    try {
      const row = (await this.records()).find((r) => r.id === id);
      if (!row) throw new Error("SOURCE_NOT_FOUND");
      if (!row.enabled) throw new Error("SOURCE_DISABLED");
      if (capability !== "perform" && capability !== "connection" && !row.capabilities[capability])
        throw new Error("SOURCE_CAPABILITY_UNAVAILABLE");
      state = await this.state(row);
      if (route && capability === "perform") {
        for (const connection of route.required) {
          const pause = state.connections?.[connection]?.pause;
          if (pause) throw taggedRouteError(pause, connection);
        }
      } else if (!route && state.pause && ["read", "collect"].includes(capability)) {
        throw new Error(state.pause);
      }
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
        const expectsPerform = (row.operations?.length ?? 0) > 0;
        const expectsLoginConnection =
          row.connections?.some((connection) => connection.login) ?? false;
        const expectsCheckConnection =
          row.connections?.some((connection) => connection.check) ?? false;
        if (
          !adapter ||
          typeof adapter.close !== "function" ||
          keys.some((k) => row.capabilities[k] !== (typeof adapter![k] === "function")) ||
          expectsPerform !== (typeof adapter.perform === "function") ||
          expectsLoginConnection !== (typeof adapter.loginConnection === "function") ||
          expectsCheckConnection !== (typeof adapter.checkConnection === "function")
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
        if (route) {
          const connection = routeFailure(error, route.required, route.primary);
          await this.saveConnectionFailure(id, connection, code, state);
        } else {
          await this.saveLegacyFailure(id, code, state);
        }
      }
      throw new Error(code);
    } finally {
      if (this.active.get(id) === controller) this.active.delete(id);
    }
  }
  async login(id: string, signal?: AbortSignal, connection?: string): Promise<void> {
    if (connection !== undefined) {
      validId(connection);
      const reservation = this.reserve(id, signal);
      try {
        const row = (await this.records()).find((entry) => entry.id === id);
        if (!row) throw new Error("SOURCE_NOT_FOUND");
        if (!row.connections?.some((entry) => entry.id === connection && entry.login))
          throw new Error("SOURCE_CAPABILITY_UNAVAILABLE");
        return this.run(
          id,
          "connection",
          async (adapter, activeSignal, registration) => {
            if (!registration.connections?.some((entry) => entry.id === connection && entry.login))
              throw new Error("SOURCE_CAPABILITY_UNAVAILABLE");
            await adapter.loginConnection!(connection, activeSignal);
            if (activeSignal.aborted) throw new Error("CANCELLED");
            const state = await this.state(registration);
            const current = state.connections?.[connection];
            if (!current) throw new Error("REGISTRY_INVALID");
            const next: ConnectionState = { ...current, auth: "unknown" };
            delete next.problem;
            await this.saveState(id, {
              ...state,
              connections: { ...state.connections, [connection]: next },
            });
          },
          signal,
          { primary: connection, required: [connection] },
          this.timeoutMs * 2,
          reservation,
        );
      } finally {
        this.releaseReservation(id, reservation);
      }
    }
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
  async check(id: string, signal?: AbortSignal, connection?: string): Promise<AuthState> {
    if (connection !== undefined) {
      validId(connection);
      const reservation = this.reserve(id, signal);
      try {
        const row = (await this.records()).find((entry) => entry.id === id);
        if (!row) throw new Error("SOURCE_NOT_FOUND");
        if (!row.connections?.some((entry) => entry.id === connection && entry.check))
          throw new Error("SOURCE_CAPABILITY_UNAVAILABLE");
        return this.run(
          id,
          "connection",
          async (adapter, activeSignal, registration) => {
            if (!registration.connections?.some((entry) => entry.id === connection && entry.check))
              throw new Error("SOURCE_CAPABILITY_UNAVAILABLE");
            const auth = await adapter.checkConnection!(connection, activeSignal);
            if (activeSignal.aborted) throw new Error("CANCELLED");
            if (!authStates.includes(auth)) throw new Error("SOURCE_INVALID_RESULT");
            const state = await this.state(registration);
            const current = state.connections?.[connection];
            if (!current) throw new Error("REGISTRY_INVALID");
            const next: ConnectionState = {
              ...current,
              auth,
              checkedAt: new Date().toISOString(),
            };
            if (auth === "ready" || auth === "not-required") {
              delete next.problem;
              delete next.pause;
            }
            if (auth === "verification-required") {
              next.pause = "VERIFICATION_REQUIRED";
              next.problem = "VERIFICATION_REQUIRED";
            }
            if (auth === "login-required" || auth === "expired") next.problem = "LOGIN_REQUIRED";
            await this.saveState(id, {
              ...state,
              connections: { ...state.connections, [connection]: next },
            });
            return auth;
          },
          signal,
          { primary: connection, required: [connection] },
          undefined,
          reservation,
        );
      } finally {
        this.releaseReservation(id, reservation);
      }
    }
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
    const reservation = this.reserve(id, signal);
    try {
      const row = (await this.records()).find((entry) => entry.id === id);
      const declaredRead = row?.operations?.find(
        (operation) => operation.id === "read" && operation.kind === "read",
      );
      if (declaredRead) {
        this.releaseReservation(id, reservation);
        const result = await this.perform(
          id,
          declaredRead.id,
          { limit: 1, maxRequests: 1, maxCharacters, url: canonical },
          signal,
        );
        if (result.kind !== "content" || result.batch.items.length !== 1)
          throw new Error("SOURCE_INVALID_RESULT");
        return result.batch.items[0]!;
      }
      return this.run(
        id,
        "read",
        async (a, s, row) => {
          if (!row.hosts.includes(new URL(canonical).hostname))
            throw new Error("SOURCE_URL_MISMATCH");
          const item = await a.read!(canonical, maxCharacters, s);
          validateItem(item, id);
          if (canonicalUrl(item.url) !== canonical) throw new Error("SOURCE_INVALID_RESULT");
          return item;
        },
        signal,
        undefined,
        undefined,
        reservation,
      );
    } finally {
      this.releaseReservation(id, reservation);
    }
  }
  async perform(
    id: string,
    operation: string,
    request: SourceOperationRequest,
    signal?: AbortSignal,
  ): Promise<SourceOperationResult> {
    validId(id);
    validId(operation);
    validateOperationRequest(request);
    const reservation = this.reserve(id, signal);
    try {
      const { row, spec, route } = await this.operationRoute(id, operation);
      validateOperationInput(spec, request);
      if (request.url && !row.hosts.includes(new URL(canonicalUrl(request.url)).hostname))
        throw new Error("SOURCE_URL_MISMATCH");
      if (spec.kind === "read" && !request.url) throw new Error("SOURCE_INVALID_INPUT");
      return this.run(
        id,
        "perform",
        async (adapter, activeSignal, registration) => {
          const currentSpec = registration.operations?.find((entry) => entry.id === operation);
          if (!currentSpec || JSON.stringify(currentSpec) !== JSON.stringify(spec))
            throw new Error("PLUGIN_CHANGED");
          const value: unknown = await adapter.perform!(
            operation,
            Object.freeze({ ...request }),
            activeSignal,
          );
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error("SOURCE_INVALID_RESULT");
          const result = value as Record<string, unknown>;
          if (spec.kind === "discover") {
            if (
              result.kind !== "discovery" ||
              !exactKeys(result, ["kind", "batch", "failureConnection"])
            )
              throw new Error("SOURCE_INVALID_RESULT");
            validateDiscoveryBatch(result.batch, id, registration.hosts, request);
            const batch = result.batch as SourceDiscoveryBatch;
            const failureConnection = result.failureConnection;
            const isFailure = safeCode(new Error(batch.stopReason)) === batch.stopReason;
            if (
              (failureConnection !== undefined &&
                (typeof failureConnection !== "string" ||
                  !route.required.includes(failureConnection))) ||
              (failureConnection !== undefined && !isFailure)
            )
              throw new Error("SOURCE_INVALID_RESULT");
            if (isFailure)
              await this.saveConnectionFailure(
                id,
                (failureConnection as string | undefined) ?? spec.connection,
                batch.stopReason,
              );
            return {
              kind: "discovery",
              batch,
              ...(failureConnection ? { failureConnection } : {}),
            };
          }
          if (
            result.kind !== "content" ||
            !exactKeys(result, ["kind", "batch", "failureConnection"])
          )
            throw new Error("SOURCE_INVALID_RESULT");
          const batch = validateContentBatch(
            result.batch,
            id,
            registration.hosts,
            request,
            spec.kind,
          );
          if (spec.kind === "read") {
            if (
              batch.failures.length ||
              canonicalUrl(batch.items[0]!.url) !== canonicalUrl(request.url!)
            )
              throw new Error("SOURCE_INVALID_RESULT");
          }
          const allowedFailureRoutes = route.required;
          const failureConnection = result.failureConnection;
          if (
            failureConnection !== undefined &&
            (typeof failureConnection !== "string" ||
              !allowedFailureRoutes.includes(failureConnection))
          )
            throw new Error("SOURCE_INVALID_RESULT");
          const failureCode = batch.failures[0]?.code;
          if (failureCode) {
            batch.stopReason = failureCode;
            await this.saveConnectionFailure(
              id,
              (failureConnection as string | undefined) ?? spec.connection,
              failureCode,
            );
          } else if (failureConnection !== undefined) {
            if (safeCode(new Error(batch.stopReason)) !== batch.stopReason)
              throw new Error("SOURCE_INVALID_RESULT");
            await this.saveConnectionFailure(id, failureConnection, batch.stopReason);
          } else {
            await this.recordOperationStop(id, spec.connection, batch.stopReason);
          }
          return { kind: "content", batch, ...(failureConnection ? { failureConnection } : {}) };
        },
        signal,
        route,
        spec.kind === "acquire" ? 600000 : this.timeoutMs,
        reservation,
      );
    } finally {
      this.releaseReservation(id, reservation);
    }
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
          validateItem(item, id);
          if (!row.hosts.includes(new URL(item.url).hostname) || ids.has(item.externalId))
            throw new Error("SOURCE_INVALID_RESULT");
          ids.add(item.externalId);
          size += Buffer.byteLength(item.text, "utf8");
        }
        if (size > MAX_BATCH_BYTES) throw new Error("SOURCE_INVALID_RESULT");
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
          if (!s.aborted) await this.saveLegacyFailure(id, code, state);
        }
        return batch;
      },
      signal,
    );
  }
  async close() {
    this.closed = true;
    this.reservations.clear();
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled([...this.adapters.keys()].map((id) => this.drop(id)));
  }
}
