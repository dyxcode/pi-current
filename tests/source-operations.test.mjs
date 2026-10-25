import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SourceRegistry } from "../src/sources/registry.ts";

async function fixture(t, body = "", timeoutMs = 45000, loginDelayMs = 0) {
  const root = await mkdtemp(join(tmpdir(), "current-operations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new SourceRegistry({ root: join(root, "data"), timeoutMs });
  t.after(() => registry.close());
  const path = join(root, "hybrid.mjs");
  await writeFile(
    path,
    `import {appendFile, mkdir} from 'node:fs/promises';
export default {
  apiVersion: 1, id: 'hybrid', name: 'Hybrid', hosts: ['example.com'],
  capabilities: {login: false, check: false, read: false, collect: false},
  connections: [
    {id: 'official', name: 'Official', login: true, check: true},
    {id: 'internal', name: 'Internal', login: true, check: true}
  ],
  operations: [
    {id: 'discover', name: 'Discover', kind: 'discover', connection: 'internal', connections: ['official', 'internal'], input: 'query'},
    {id: 'read', name: 'Read', kind: 'read', connection: 'internal', input: 'url'},
    {id: 'acquire', name: 'Acquire', kind: 'acquire', connection: 'internal', connections: ['official', 'internal'], input: 'query'},
    {id: 'own-read', name: 'Own read', kind: 'read', connection: 'official', input: 'url'}
  ],
  async create(ctx) {
    await mkdir(ctx.dataDir, {recursive: true});
    const mark = async value => appendFile(ctx.dataDir + '/calls', value + '\\n');
    return {
      async perform(operation, request, signal) {
        await mark(operation + ':' + JSON.stringify(request));
        ${
          body ||
          `
        if (operation === 'discover') return {kind: 'discovery', batch: {items: [{
          sourceId: 'hybrid', externalId: 'd1', url: 'https://example.com/a',
          title: 'Found', summary: '', contentType: 'article', discoveredAt: '2026-10-24T00:00:00.000Z', observedPosition: 1
        }], stopReason: 'complete'}};
        if (operation === 'own-read') {
          const error = new Error('ACCESS_DENIED');
          Object.defineProperty(error, 'connection', {value: 'official'});
          throw error;
        }
        if (operation === 'read') return {kind: 'content', batch: {
          items: [{sourceId: 'hybrid', externalId: operation, url: request.url, title: 'Read', text: 'Body', retrievedAt: '2026-10-24T00:00:00.000Z', sourceCompleteness: 'unknown', truncated: false}],
          failures: [], stopReason: 'complete'
        }};
        if (operation === 'acquire') return {kind: 'content', failureConnection: 'official', batch: {
          items: [{sourceId: 'hybrid', externalId: 'a1', url: 'https://example.com/a', title: 'Found', text: 'Body', retrievedAt: '2026-10-24T00:00:00.000Z', sourceCompleteness: 'unknown', truncated: false}],
          failures: [{externalId: 'a2', code: 'RATE_LIMITED'}], stopReason: 'complete'
        }};
        throw new Error('SOURCE_ERROR');`
        }
      },
      async loginConnection(connection) {
        await mark('login:' + connection);
        ${loginDelayMs ? `await new Promise(resolve => setTimeout(resolve, ${loginDelayMs}));` : ""}
        if (connection === 'internal') throw new Error('ACCESS_DENIED');
      },
      async checkConnection(connection) {
        await mark('check:' + connection);
        return 'ready';
      },
      async close() {}
    };
  }
};`,
  );
  return { root, registry, path };
}

async function legacyPauseFixture(t, mode = "partial") {
  const root = await mkdtemp(join(tmpdir(), "current-legacy-pause-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new SourceRegistry({ root: join(root, "data"), timeoutMs: 1000 });
  t.after(() => registry.close());
  const path = join(root, "legacy.mjs");
  await writeFile(
    path,
    `export default {
      apiVersion: 1, id: 'legacy', name: 'Legacy', hosts: ['example.com'],
      capabilities: {login: false, check: false, read: false, collect: true},
      async create() { return {
        async collect() {
          ${mode === "throw" ? "throw new Error('ACCESS_DENIED');" : `return {items: [], failures: [{externalId: 'next', code: 'RATE_LIMITED'}], stopReason: 'complete'};`}
        },
        async close() {}
      }; }
    };`,
  );
  return { root, registry, path };
}

function request(overrides = {}) {
  return { limit: 2, maxRequests: 3, maxCharacters: 2000, query: "topic", ...overrides };
}

test("a persisted legacy pause is inherited when named connection state is first created", async (t) => {
  const f = await legacyPauseFixture(t);
  await f.registry.register(f.path);
  const legacyBatch = await f.registry.collect("legacy", 2);
  assert.equal(legacyBatch.stopReason, "RATE_LIMITED");
  assert.equal((await f.registry.list())[0].pause, "RATE_LIMITED");

  await f.registry.setEnabled("legacy", false);
  const registryPath = join(f.root, "data/source-registry.json");
  const saved = JSON.parse(await readFile(registryPath, "utf8"));
  saved.sources[0].connections = [
    { id: "official", name: "Official", login: true, check: true },
    { id: "internal", name: "Internal", login: true, check: true },
  ];
  saved.sources[0].operations = [
    {
      id: "discover",
      name: "Discover",
      kind: "discover",
      connection: "internal",
      connections: ["official", "internal"],
      input: "query",
    },
  ];
  await writeFile(registryPath, `${JSON.stringify(saved, null, 2)}\n`);
  await writeFile(
    f.path,
    `export default {
      apiVersion: 1, id: 'legacy', name: 'Legacy', hosts: ['example.com'],
      capabilities: {login: false, check: false, read: false, collect: true},
      connections: [{id:'official',name:'Official',login:true,check:true},{id:'internal',name:'Internal',login:true,check:true}],
      operations: [{id:'discover',name:'Discover',kind:'discover',connection:'internal',connections:['official','internal'],input:'query'}],
      async create() { return {
        async collect() { return {items:[],failures:[],stopReason:'complete'}; },
        async perform() { throw new Error('SOURCE_ERROR'); },
        async loginConnection() {}, async checkConnection() { return 'ready'; },
        async close() {}
      }; }
    };`,
  );
  await f.registry.setEnabled("legacy", true);

  const status = (await f.registry.list())[0];
  assert.equal(status.connectionStates.official.pause, "RATE_LIMITED");
  assert.equal(status.connectionStates.internal.pause, "RATE_LIMITED");
  await assert.rejects(f.registry.perform("legacy", "discover", request()), /RATE_LIMITED/);
  const persisted = JSON.parse(
    await readFile(join(f.root, "data/source-state/legacy.json"), "utf8"),
  );
  assert.equal(persisted.connections.official.pause, "RATE_LIMITED");
  assert.equal(persisted.connections.internal.pause, "RATE_LIMITED");
});

test("legacy readiness does not make newly declared named connections ready", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "current-legacy-ready-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new SourceRegistry({ root: join(root, "data") });
  t.after(() => registry.close());
  const path = join(root, "legacy-ready.mjs");
  await writeFile(
    path,
    `export default {
      apiVersion: 1, id: 'legacy-ready', name: 'Legacy Ready', hosts: ['example.com'],
      capabilities: {login: false, check: true, read: false, collect: false},
      async create() { return {async check() { return 'ready'; }, async close() {}}; }
    };`,
  );
  await registry.register(path);
  await registry.check("legacy-ready");

  await registry.setEnabled("legacy-ready", false);
  const registryPath = join(root, "data/source-registry.json");
  const saved = JSON.parse(await readFile(registryPath, "utf8"));
  saved.sources[0].connections = [
    { id: "official", name: "Official", login: true, check: true },
    { id: "internal", name: "Internal", login: true, check: true },
  ];
  await writeFile(registryPath, `${JSON.stringify(saved, null, 2)}\n`);
  await writeFile(
    path,
    `export default {
      apiVersion: 1, id: 'legacy-ready', name: 'Legacy Ready', hosts: ['example.com'],
      capabilities: {login: false, check: true, read: false, collect: false},
      connections: [{id:'official',name:'Official',login:true,check:true},{id:'internal',name:'Internal',login:true,check:true}],
      async create() { return {
        async check() { return 'ready'; },
        async checkConnection() { return 'ready'; },
        async loginConnection() {}, async close() {}
      }; }
    };`,
  );
  await registry.setEnabled("legacy-ready", true);

  let status = (await registry.list())[0];
  assert.equal(status.auth, "ready");
  assert.equal(status.connectionStates.official.auth, "unknown");
  assert.equal(status.connectionStates.internal.auth, "unknown");
  assert.equal(status.connectionStates.official.checkedAt, undefined);
  assert.equal(status.connectionStates.internal.checkedAt, undefined);

  await registry.check("legacy-ready", undefined, "official");
  status = (await registry.list())[0];
  assert.equal(status.connectionStates.official.auth, "ready");
  assert.ok(status.connectionStates.official.checkedAt);
  assert.equal(status.connectionStates.internal.auth, "unknown");
  assert.equal(status.connectionStates.internal.checkedAt, undefined);
});

test("legacy collection auth and access pauses propagate to all named routes", async (t) => {
  for (const mode of ["partial", "throw", "login"]) {
    const root = await mkdtemp(join(tmpdir(), `current-hybrid-legacy-${mode}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const registry = new SourceRegistry({ root: join(root, "data") });
    t.after(() => registry.close());
    const path = join(root, "hybrid-legacy.mjs");
    await writeFile(
      path,
      `export default {
        apiVersion: 1, id: 'legacy-hybrid', name: 'Legacy Hybrid', hosts: ['example.com'],
        capabilities: {login: false, check: false, read: false, collect: true},
        connections: [{id:'official',name:'Official',login:true,check:true},{id:'internal',name:'Internal',login:true,check:true}],
        operations: [{id:'discover',name:'Discover',kind:'discover',connection:'internal',connections:['official','internal'],input:'query'}],
        async create() { return {
          async collect() {
            ${mode === "throw" ? "throw new Error('ACCESS_DENIED');" : mode === "login" ? "throw new Error('LOGIN_REQUIRED');" : `return {items:[],failures:[{externalId:'next',code:'RATE_LIMITED'}],stopReason:'complete'};`}
          },
          async perform() { return {kind:'discovery',batch:{items:[],stopReason:'complete'}}; },
          async loginConnection() {}, async checkConnection() { return 'ready'; },
          async close() {}
        }; }
      };`,
    );
    await registry.register(path);
    await registry.check("legacy-hybrid", undefined, "official");
    await registry.check("legacy-hybrid", undefined, "internal");
    const expected =
      mode === "throw" ? "ACCESS_DENIED" : mode === "login" ? "LOGIN_REQUIRED" : "RATE_LIMITED";
    if (mode === "partial")
      assert.equal((await registry.collect("legacy-hybrid", 2)).stopReason, expected);
    else await assert.rejects(registry.collect("legacy-hybrid", 2), new RegExp(expected));
    const status = (await registry.list())[0];
    const expectedPause = mode === "login" ? undefined : expected;
    assert.equal(status.connectionStates.official.pause, expectedPause);
    assert.equal(status.connectionStates.internal.pause, expectedPause);
    if (mode === "login") {
      assert.equal(status.connectionStates.official.auth, "expired");
      assert.equal(status.connectionStates.internal.auth, "expired");
    } else {
      assert.equal(status.connectionStates.official.auth, "ready");
      assert.equal(status.connectionStates.internal.auth, "ready");
    }
  }
});

test("named connection login receives twice the normal operation deadline", async (t) => {
  const f = await fixture(t, "", 50, 70);
  await f.registry.register(f.path);
  await f.registry.login("hybrid", undefined, "official");
  assert.equal((await f.registry.list())[0].connectionStates.official.auth, "unknown");
});

test("operation input and capability failures remain batch errors without pausing a connection", async (t) => {
  for (const code of [
    "SOURCE_INVALID_INPUT",
    "SOURCE_CAPABILITY_UNAVAILABLE",
    "SOURCE_URL_MISMATCH",
  ]) {
    const f = await fixture(
      t,
      `return {kind:'content',batch:{items:[],failures:[{externalId:'bad',code:${JSON.stringify(code)}}],stopReason:'complete'}};`,
    );
    await f.registry.register(f.path);
    const result = await f.registry.perform("hybrid", "acquire", request());
    assert.equal(result.batch.stopReason, code);
    assert.equal(result.batch.failures[0].code, code);
    assert.equal((await f.registry.list())[0].connectionStates.internal.problem, undefined);
    assert.equal((await f.registry.list())[0].connectionStates.internal.pause, undefined);
  }
});

test("optional operations register without creating an adapter and validate discovery results", async (t) => {
  const f = await fixture(t);
  await f.registry.register(f.path);
  const listed = (await f.registry.list())[0];
  assert.deepEqual(listed.connections, [
    { id: "official", name: "Official", login: true, check: true },
    { id: "internal", name: "Internal", login: true, check: true },
  ]);
  assert.equal(listed.connectionStates.internal.auth, "not-connected");
  await assert.rejects(readFile(join(f.root, "data/source-data/hybrid/calls")), /ENOENT/);

  const result = await f.registry.perform("hybrid", "discover", request());
  assert.equal(result.kind, "discovery");
  assert.equal(result.batch.items[0].summary, "");
  assert.equal((await f.registry.list())[0].connectionStates.internal.pause, undefined);
});

test("read routes through a declared read operation and preserves the legacy return shape", async (t) => {
  const f = await fixture(t);
  await f.registry.register(f.path);
  const item = await f.registry.read("hybrid", "https://example.com/a", 2000);
  assert.equal(item.externalId, "read");
  assert.match(
    await readFile(join(f.root, "data/source-data/hybrid/calls"), "utf8"),
    /read:\{"limit":1,"maxRequests":1,"maxCharacters":2000,"url":"https:\/\/example.com\/a"\}/,
  );
});

test("new operation requests keep one source reservation while the adapter is running", async (t) => {
  const f = await fixture(
    t,
    `
      if (operation === 'discover') {
        await new Promise(resolve => setTimeout(resolve, 50));
        return {kind:'discovery',batch:{items:[],stopReason:'complete'}};
      }
      throw new Error('SOURCE_ERROR');`,
  );
  await f.registry.register(f.path);
  const first = f.registry.perform("hybrid", "discover", request());
  await assert.rejects(f.registry.perform("hybrid", "discover", request()), /SOURCE_BUSY/);
  const result = await first;
  assert.equal(result.kind, "discovery");
  const calls = await readFile(join(f.root, "data/source-data/hybrid/calls"), "utf8");
  assert.equal(calls.trim().split("\n").length, 1);
});

test("operation pauses are connection-scoped and checks clear only the selected connection", async (t) => {
  const f = await fixture(t);
  await f.registry.register(f.path);

  const partial = await f.registry.perform("hybrid", "acquire", request());
  assert.equal(partial.batch.items.length, 1);
  assert.equal(partial.batch.stopReason, "RATE_LIMITED");
  let status = (await f.registry.list())[0];
  assert.equal(status.connectionStates.official.pause, "RATE_LIMITED");
  assert.equal(status.connectionStates.internal.pause, undefined);
  const persisted = JSON.parse(
    await readFile(join(f.root, "data/source-state/hybrid.json"), "utf8"),
  );
  assert.equal(persisted.connections.official.pause, "RATE_LIMITED");
  await assert.rejects(f.registry.perform("hybrid", "acquire", request()), /RATE_LIMITED/);
  assert.equal((await f.registry.read("hybrid", "https://example.com/a", 2000)).text, "Body");

  await assert.rejects(f.registry.login("hybrid", undefined, "internal"), /ACCESS_DENIED/);
  status = (await f.registry.list())[0];
  assert.equal(status.connectionStates.official.pause, "RATE_LIMITED");
  assert.equal(status.connectionStates.internal.pause, "ACCESS_DENIED");
  await f.registry.check("hybrid", undefined, "official");
  status = (await f.registry.list())[0];
  assert.equal(status.connectionStates.official.pause, undefined);
  assert.equal(status.connectionStates.internal.pause, "ACCESS_DENIED");
  await f.registry.check("hybrid", undefined, "internal");
  assert.equal((await f.registry.list())[0].connectionStates.internal.pause, undefined);
});

test("thrown operation failures can pause a declared dependency connection", async (t) => {
  const f = await fixture(t);
  await f.registry.register(f.path);
  await assert.rejects(
    f.registry.perform("hybrid", "own-read", {
      limit: 1,
      maxRequests: 1,
      maxCharacters: 2000,
      url: "https://example.com/a",
    }),
    /ACCESS_DENIED/,
  );
  const status = (await f.registry.list())[0];
  assert.equal(status.connectionStates.official.pause, "ACCESS_DENIED");
  assert.equal(status.connectionStates.internal.pause, undefined);
});

test("partial discovery results attribute a pause to a secondary dependency", async (t) => {
  const f = await fixture(
    t,
    `
      if (operation === 'discover') return {kind: 'discovery', failureConnection: 'official', batch: {
        items: [{sourceId: 'hybrid', externalId: 'd1', url: 'https://example.com/a', title: 'Found', summary: '', contentType: 'article', discoveredAt: '2026-10-24T00:00:00.000Z'}],
        stopReason: 'RATE_LIMITED'
      }};
      if (operation === 'read') return {kind: 'content', batch: {
        items: [{sourceId: 'hybrid', externalId: 'read', url: request.url, title: 'Read', text: 'Body', retrievedAt: '2026-10-24T00:00:00.000Z', sourceCompleteness: 'unknown', truncated: false}],
        failures: [], stopReason: 'complete'
      }};
      throw new Error('SOURCE_ERROR');`,
  );
  await f.registry.register(f.path);
  const result = await f.registry.perform("hybrid", "discover", request());
  assert.equal(result.batch.stopReason, "RATE_LIMITED");
  assert.equal(result.failureConnection, "official");
  const status = (await f.registry.list())[0];
  assert.equal(status.connectionStates.official.pause, "RATE_LIMITED");
  assert.equal(status.connectionStates.internal.pause, undefined);
  assert.equal((await f.registry.read("hybrid", "https://example.com/a", 2000)).externalId, "read");
  await assert.rejects(f.registry.perform("hybrid", "discover", request()), /RATE_LIMITED/);
});

test("discovery failure routes must be declared and paired with an error stop", async (t) => {
  for (const [failureConnection, stopReason] of [
    ["unknown", "RATE_LIMITED"],
    ["official", "complete"],
  ]) {
    const f = await fixture(
      t,
      `return {kind: 'discovery', failureConnection: ${JSON.stringify(failureConnection)}, batch: {items: [], stopReason: ${JSON.stringify(stopReason)}}};`,
    );
    await f.registry.register(f.path);
    await assert.rejects(
      f.registry.perform("hybrid", "discover", request()),
      /SOURCE_INVALID_RESULT/,
    );
  }
});

test("acquisition uses a bounded long deadline while discovery keeps the normal timeout", async (t) => {
  const f = await fixture(
    t,
    `
      if (operation === 'discover') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 80);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('CANCELLED')); }, {once: true});
        });
        return {kind: 'discovery', batch: {items: [], stopReason: 'complete'}};
      }
      if (operation === 'acquire') {
        await new Promise(resolve => setTimeout(resolve, 80));
        return {kind: 'content', batch: {items: [{sourceId: 'hybrid', externalId: 'a1', url: 'https://example.com/a', title: 'Found', text: 'Body', retrievedAt: '2026-10-24T00:00:00.000Z', sourceCompleteness: 'unknown', truncated: false}], failures: [], stopReason: 'complete'}};
      }
      throw new Error('SOURCE_ERROR');`,
    20,
  );
  await f.registry.register(f.path);
  await assert.rejects(f.registry.perform("hybrid", "discover", request()), /TIMEOUT/);
  const result = await f.registry.perform("hybrid", "acquire", request());
  assert.equal(result.batch.items[0].externalId, "a1");
});

test("operation requests and results reject invalid bounds, kind mismatches, and unknown fields", async (t) => {
  const f = await fixture(
    t,
    `return {kind: 'content', extra: true, batch: {items: [], failures: [], stopReason: 'complete'}};`,
  );
  await f.registry.register(f.path);
  await assert.rejects(
    f.registry.perform("hybrid", "discover", request({ maxRequests: 21 })),
    /SOURCE_INVALID_INPUT/,
  );
  await assert.rejects(
    f.registry.perform("hybrid", "discover", request({ extra: true })),
    /SOURCE_INVALID_INPUT/,
  );
  await assert.rejects(
    f.registry.perform("hybrid", "discover", request()),
    /SOURCE_INVALID_RESULT/,
  );
});

test("operation results reject unrecognized stop text before it can enter a receipt", async (t) => {
  const f = await fixture(
    t,
    `return {kind: 'content', batch: {items: [], failures: [], stopReason: 'PRIVATE_TITLE'}};`,
  );
  await f.registry.register(f.path);
  await assert.rejects(f.registry.perform("hybrid", "acquire", request()), /SOURCE_INVALID_RESULT/);
});

test("discovery results reject foreign identities, unowned hosts, and unknown item fields", async (t) => {
  const badItems = [
    `{sourceId: 'other', externalId: 'd1', url: 'https://example.com/a', title: 'Found', summary: '', contentType: 'article', discoveredAt: '2026-10-24T00:00:00.000Z'}`,
    `{sourceId: 'hybrid', externalId: 'd1', url: 'https://other.example/a', title: 'Found', summary: '', contentType: 'article', discoveredAt: '2026-10-24T00:00:00.000Z'}`,
    `{sourceId: 'hybrid', externalId: 'd1', url: 'https://example.com/a', title: 'Found', summary: '', contentType: 'article', discoveredAt: '2026-10-24T00:00:00.000Z', extra: true}`,
  ];
  for (const item of badItems) {
    const f = await fixture(
      t,
      `return {kind: 'discovery', batch: {items: [${item}], stopReason: 'complete'}};`,
    );
    await f.registry.register(f.path);
    await assert.rejects(
      f.registry.perform("hybrid", "discover", request()),
      /SOURCE_INVALID_RESULT/,
    );
  }
});

test("connection metadata and operation declarations must reference known routes", async (t) => {
  const f = await fixture(t);
  const invalid = join(f.root, "invalid.mjs");
  await writeFile(
    invalid,
    `export default {apiVersion:1,id:'invalid',name:'Invalid',hosts:[],capabilities:{login:false,check:false,read:false,collect:false},connections:[{id:'one',name:'One',login:false,check:false}],operations:[{id:'search',name:'Search',kind:'discover',connection:'missing'}],async create(){return {async close(){}}}};`,
  );
  await assert.rejects(f.registry.register(invalid), /PLUGIN_INVALID/);
});
