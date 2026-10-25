import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sourceHarness, memoryLibrary, deferred, batch } from "./helpers/source-harness.mjs";
import { createSearchHarness } from "./helpers/search-harness.mjs";
import { registerSources } from "../src/pi/sources.ts";
import { createEventBus, wrapRegisteredTools } from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { operationIntent } from "../src/pi/operation-intent.ts";

const plugin = `export default {
  apiVersion:1,id:'sample',name:'Sample',hosts:['example.com'],
  capabilities:{login:false,check:false,read:false,collect:false},
  connections:[{id:'official',name:'Official',login:false,check:false}],
  operations:[
    {id:'search',name:'Search',kind:'discover',connection:'official',input:'query'},
    {id:'fetch-search',name:'Fetch search',kind:'acquire',connection:'official',input:'query'},
  ],
  async create(){return {async close(){},async perform(operation,request){
    if(operation==='search')return {kind:'discovery',batch:{items:[{
      sourceId:'sample',externalId:'one',url:'https://example.com/a',title:'PRIVATE_TITLE',
      summary:'PRIVATE_SUMMARY',contentType:'answer',discoveredAt:'2026-01-01T00:00:00Z'
    }],stopReason:'complete'}};
    return {kind:'content',batch:{items:[{
      sourceId:'sample',externalId:'one',url:'https://example.com/a',title:'PRIVATE_TITLE',
      text:'PRIVATE_BODY',retrievedAt:'2026-01-01T00:00:00Z',sourceCompleteness:'unknown',truncated:false
    }],failures:[],stopReason:'complete'}};
  }}}};
`;
const input = (text) => ({ text, source: "interactive" });

test("discovery requires the exact requested query and never writes summaries to the library", async (t) => {
  const f = await sourceHarness(t, { plugin });
  await f.registry.register(f.modulePath);
  const tool = f.tools.get("current_source_operation");
  assert.ok(tool, "operation tool must be registered");
  const args = { source: "sample", operation: "search", query: "local tools", limit: 3 };
  await assert.rejects(tool.execute("none", args), /SOURCE_OPERATION_NOT_REQUESTED/);
  await f.emit("input", input("Search sample for local tools limit 3"));
  await assert.rejects(
    tool.execute("changed", { ...args, query: "different" }),
    /SOURCE_OPERATION_NOT_REQUESTED/,
  );
  const result = await tool.execute("discover", args);
  assert.equal(result.structuredContent.count, 1);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  assert.match(JSON.stringify(f.entries), /PRIVATE_SUMMARY/);
  assert.deepEqual(await f.library.search({ query: "PRIVATE" }), []);
  await assert.rejects(tool.execute("repeat", args), /SOURCE_OPERATION_NOT_REQUESTED/);
});

test("fetch can remain unsaved and an explicit later save uses an opaque reference without refetching", async (t) => {
  const f = await sourceHarness(t, { plugin });
  await f.registry.register(f.modulePath);
  const tool = f.tools.get("current_source_operation");
  await f.emit("input", input("Fetch 2 items from sample search: local tools"));
  const result = await tool.execute("fetch", {
    source: "sample",
    operation: "fetch-search",
    query: "local tools",
    limit: 2,
  });
  const pendingRef = result.structuredContent.pendingRef;
  assert.match(pendingRef, /^[a-f0-9-]{36}$/);
  assert.deepEqual(await f.library.search({ query: "PRIVATE" }), []);
  await f.registry.remove("sample");
  await f.emit("input", input(`Save fetched batch ${pendingRef}`));
  const saved = await f.tools.get("current_source_save").execute("save", { pendingRef });
  assert.equal(saved.structuredContent.references.length, 1);
  assert.ok(!JSON.stringify(saved).includes("PRIVATE_"));
  assert.equal((await f.library.search({ query: "PRIVATE_BODY" })).length, 1);
  await assert.rejects(
    f.tools.get("current_source_save").execute("repeat", { pendingRef }),
    /SOURCE_SAVE_NOT_REQUESTED/,
  );
});

test("save intent, count, request budget and input origin cannot expand a composed grant", async (t) => {
  const f = await sourceHarness(t, { plugin });
  await f.registry.register(f.modulePath);
  const tool = f.tools.get("current_source_operation");
  const args = { source: "sample", operation: "fetch-search", query: "tools", limit: 2 };
  await f.emit("input", {
    ...input("Fetch 2 items from sample search: tools"),
    source: "extension",
  });
  await assert.rejects(tool.execute("generated", args), /SOURCE_OPERATION_NOT_REQUESTED/);
  await f.emit("input", input("Fetch 2 items from sample search: tools"));
  await assert.rejects(
    tool.execute("save", { ...args, save: true }),
    /SOURCE_OPERATION_NOT_REQUESTED/,
  );
  await assert.rejects(tool.execute("count", { ...args, limit: 3 }), /SOURCE_OPERATION_LIMIT/);
  await assert.rejects(
    tool.execute("budget", { ...args, maxRequests: 20 }),
    /SOURCE_OPERATION_LIMIT/,
  );
  await f.emit("agent_end");
  await assert.rejects(tool.execute("ended", args), /SOURCE_OPERATION_NOT_REQUESTED/);
});

test("an explicitly combined fetch-and-save request persists only the returned body", async (t) => {
  const f = await sourceHarness(t, { plugin });
  await f.registry.register(f.modulePath);
  await f.emit("input", input("Fetch and save 2 items from sample search: tools"));
  const result = await f.tools.get("current_source_operation").execute("combined", {
    source: "sample",
    operation: "fetch-search",
    query: "tools",
    limit: 2,
    save: true,
  });
  assert.equal(result.structuredContent.references.length, 1);
  assert.equal(result.structuredContent.pendingRef, undefined);
});

test("cached source summaries report each connection's status instead of the legacy auth default", async (t) => {
  const f = await sourceHarness(t, {
    plugin: plugin.replace(
      "connections:[{id:'official',name:'Official',login:false,check:false}]",
      "connections:[{id:'official',name:'Official',login:false,check:false},{id:'session',name:'Session',login:false,check:false}]",
    ),
  });
  await f.registry.register(f.modulePath);
  await mkdir(join(f.data, "source-state"), { recursive: true });
  await writeFile(
    join(f.data, "source-state/sample.json"),
    JSON.stringify({
      auth: "not-required",
      connections: {
        official: { auth: "ready" },
        session: { auth: "ready", pause: "RATE_LIMITED", problem: "RATE_LIMITED" },
      },
    }),
  );
  const result = await f.tools.get("current_sources").execute("status", { action: "list" });
  assert.match(result.structuredContent.sources[0].status, /Official: ready/);
  assert.match(result.structuredContent.sources[0].status, /Session: RATE_LIMITED/);
  assert.deepEqual(
    result.structuredContent.sources[0].operations.map((operation) => operation.id),
    ["search", "fetch-search"],
  );
  assert.ok(!JSON.stringify(result).includes(f.modulePath));
  await writeFile(
    join(f.data, "source-state/sample.json"),
    JSON.stringify({
      auth: "ready",
      pause: "ACCESS_DENIED",
      problem: "ACCESS_DENIED",
      connections: { official: { auth: "ready" }, session: { auth: "ready" } },
    }),
  );
  const legacy = await f.tools.get("current_sources").execute("legacy-pause", { action: "list" });
  assert.match(legacy.structuredContent.sources[0].status, /source: ACCESS_DENIED/);
  assert.match(legacy.structuredContent.sources[0].status, /Official: ready/);
});

test("arbitrary acquire IDs receive a bounded multi-request grant based on their declared kind", async (t) => {
  const f = await sourceHarness(t, {
    plugin: plugin.replace("id:'fetch-search'", "id:'retrieve'"),
  });
  await f.registry.register(f.modulePath);
  await f.emit("input", input("Run retrieve from sample limit 2 query: tools"));
  const result = await f.tools.get("current_source_operation").execute("retrieve", {
    source: "sample",
    operation: "retrieve",
    query: "tools",
    limit: 2,
    maxRequests: 3,
  });
  assert.equal(result.structuredContent.count, 1);
});

test("Chinese composed requests preserve the source and explicit save intent", () => {
  const intent = operationIntent("读取并保存Sample热榜3条内容");
  assert.equal(intent.source, "Sample");
  assert.equal(intent.operation, "fetch-hot-list");
  assert.equal(intent.save, true);
});

test("later saving preserves the original request count and acquisition start time", async (t) => {
  let retained;
  const library = memoryLibrary({
    async save(request) {
      retained = request;
      return {
        ...request.batch,
        items: request.batch.items.map((item) => ({
          ...item,
          itemId: "11111111-1111-4111-8111-111111111111",
          versionId: "22222222-2222-4222-8222-222222222222",
        })),
      };
    },
  });
  const f = await sourceHarness(t, {
    library,
    plugin: plugin.replace(
      "async perform(operation,request){",
      "async perform(operation,request){await new Promise(resolve=>setTimeout(resolve,20));",
    ),
  });
  await f.registry.register(f.modulePath);
  await f.emit("input", input("Fetch 2 items from sample search: tools"));
  const result = await f.tools
    .get("current_source_operation")
    .execute("fetch", { source: "sample", operation: "fetch-search", query: "tools", limit: 2 });
  await f.emit("input", input("Save last fetched content"));
  await f.tools
    .get("current_source_save")
    .execute("save", { pendingRef: result.structuredContent.pendingRef });
  assert.equal(retained.requestedCount, 2);
  assert.equal(retained.batch.items.length, 1);
  assert.ok(Date.parse(retained.startedAt) < Date.parse(retained.batch.collectedAt));
});

test("the actual Pi wrapper runs generic operation/save tools with valid schemas and private receipts", async (t) => {
  const f = await sourceHarness(t, { plugin });
  await f.registry.register(f.modulePath);
  const h = await createSearchHarness(t);
  const extension = await loadExtensionFromFactory(
    (pi) => registerSources(pi, { root: f.data, registry: f.registry, library: f.library }),
    h.cwd,
    createEventBus(),
    h.loader.getExtensions().runtime,
  );
  const wrapped = wrapRegisteredTools([...extension.tools.values()], h.runner);
  const emit = async (text) => {
    for (const handler of extension.handlers.get("input") ?? [])
      await handler({ type: "input", text, source: "interactive" }, {});
  };
  await emit("Fetch 2 items from sample search: tools");
  const result = await wrapped
    .find((tool) => tool.name === "current_source_operation")
    .execute("fetch", { source: "sample", operation: "fetch-search", query: "tools", limit: 2 });
  assert.equal(result.structuredContent.count, 1);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  const pendingRef = result.structuredContent.pendingRef;
  await emit(`Save fetched batch ${pendingRef}`);
  const saved = await wrapped
    .find((tool) => tool.name === "current_source_save")
    .execute("save", { pendingRef });
  assert.equal(saved.structuredContent.references.length, 1);
  assert.ok(!JSON.stringify(saved).includes("PRIVATE_"));
});

test("a late operation result cannot save or publish after its Pi session ends", async (t) => {
  const pending = deferred(),
    started = deferred();
  let saves = 0;
  const registry = {
    async list() {
      return [
        {
          id: "sample",
          name: "Sample",
          operations: [
            {
              id: "fetch-search",
              name: "Fetch",
              kind: "acquire",
              connection: "session",
              input: "query",
            },
          ],
        },
      ];
    },
    async perform() {
      started.resolve();
      return pending.promise;
    },
    async close() {},
  };
  const library = memoryLibrary({
    async save() {
      saves++;
      throw new Error("UNEXPECTED");
    },
  });
  const f = await sourceHarness(t, { registry, library });
  await f.emit("input", input("Fetch and save 2 items from sample search: tools"));
  const executing = f.tools.get("current_source_operation").execute("late", {
    source: "sample",
    operation: "fetch-search",
    query: "tools",
    limit: 2,
    save: true,
  });
  await started.promise;
  await f.emit("session_shutdown");
  pending.resolve({ kind: "content", batch: batch() });
  await assert.rejects(executing, /CANCELLED/);
  assert.equal(saves, 0);
  assert.equal(f.entries.length, 0);
});

test("an uncertain operation save retains local content and does not claim success or refetch", async (t) => {
  let saves = 0;
  const library = memoryLibrary({
    async save() {
      saves++;
      throw new Error("LIBRARY_WRITE_UNCERTAIN");
    },
  });
  const f = await sourceHarness(t, { plugin, library });
  await f.registry.register(f.modulePath);
  await f.emit("input", input("Fetch and save 2 items from sample search: tools"));
  const result = await f.tools.get("current_source_operation").execute("uncertain", {
    source: "sample",
    operation: "fetch-search",
    query: "tools",
    limit: 2,
    save: true,
  });
  assert.equal(result.structuredContent.status, "save-unconfirmed");
  assert.equal(result.structuredContent.references, undefined);
  assert.match(result.structuredContent.pendingRef, /^[a-f0-9-]{36}$/);
  assert.equal(saves, 1);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
});
