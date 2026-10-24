import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { registerSources } from "../../src/pi/sources.ts";
import { SourceRegistry } from "../../src/sources/registry.ts";
import { SQLiteContentLibrary } from "../../src/library/store.ts";

export function item(overrides = {}) {
  return {
    sourceId: "sample",
    externalId: "one",
    url: "https://example.com/a",
    title: "PRIVATE_TITLE",
    text: "PRIVATE_BODY",
    retrievedAt: "2026-01-01T00:00:00.000Z",
    sourceCompleteness: "unknown",
    truncated: false,
    ...overrides,
  };
}

export function batch(overrides = {}) {
  return { items: [item()], failures: [], stopReason: "limit", ...overrides };
}

export function saveRequest() {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    startedAt: now,
    requestedCount: 1,
    batch: { ...batch(), id: randomUUID(), sourceId: "sample", collectedAt: now },
  };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function row() {
  return {
    id: "sample",
    name: "Sample",
    modulePath: "/synthetic/plugin.mjs",
    hosts: ["example.com"],
    enabled: true,
    auth: "ready",
    capabilities: { login: true, check: true, read: true, collect: true },
  };
}

export function sourcePlugin(collectResult = batch()) {
  return `export default {
    apiVersion: 1, id: 'sample', name: 'Sample', hosts: ['example.com'],
    capabilities: { login: true, check: true, read: true, collect: true },
    async create() {
      return {
        async login() {}, async check() { return 'ready'; },
        async read(url) { return { ...${JSON.stringify(item())}, url }; },
        async collect() { return ${JSON.stringify(collectResult)}; },
        async close() {},
      };
    },
  };`;
}

export async function sourceHarness(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "current-behavior-"));
  const data = join(root, "data");
  const registry = options.registry ?? new SourceRegistry({ root: data });
  const library = options.library ?? new SQLiteContentLibrary(data);
  const modulePath = join(root, "fixture.mjs");
  await writeFile(modulePath, options.plugin ?? sourcePlugin());
  const commands = new Map(),
    tools = new Map(),
    events = new Map(),
    entries = [],
    renderers = new Map();
  const pi = {
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (name, handler) => {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerEntryRenderer: (name, renderer) => renderers.set(name, renderer),
    appendEntry: (name, value) => entries.push({ name, data: value }),
  };
  const api = registerSources(pi, { root: data, registry, library });
  const emit = async (name, value = {}) => {
    for (const handler of events.get(name) ?? []) await handler(value);
  };
  t.after(async () => {
    await emit("session_shutdown");
    await Promise.allSettled([registry.close(), library.close()]);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    data,
    registry,
    library,
    modulePath,
    api,
    emit,
    commands,
    tools,
    entries,
    renderers,
  };
}

export function memoryLibrary(overrides = {}) {
  return {
    async save(request) {
      return {
        ...request.batch,
        items: request.batch.items.map((value) => ({
          ...value,
          itemId: randomUUID(),
          versionId: randomUUID(),
        })),
      };
    },
    async latest() {},
    async search() {
      return [];
    },
    async read() {},
    async remove() {
      return false;
    },
    async close() {},
    ...overrides,
  };
}
