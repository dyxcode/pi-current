import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { SourceRegistry } from "../../src/sources/registry.ts";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-current-sources-"));
  const data = join(root, "runtime");
  await mkdir(join(data, "source-state"), { recursive: true });
  await mkdir(join(data, "source-data", "retired"), { recursive: true });
  const legacy = {
    registry: '{"legacy":"registry"}',
    state: '{"auth":"ready","pause":"RATE_LIMITED"}',
    data: "retained plugin data\n",
  };
  await writeFile(join(data, "source-registry.json"), legacy.registry);
  await writeFile(join(data, "source-state", "retired.json"), legacy.state);
  await writeFile(join(data, "source-data", "retired", "marker"), legacy.data);
  const registry = new SourceRegistry({ root: data });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, data, legacy, registry };
}

function moduleText(id, name = id) {
  return `export default {
    id: ${JSON.stringify(id)},
    name: ${JSON.stringify(name)},
    async fetch() { return { items: [], issues: [] }; },
  };`;
}

test("the built-in feed is listed and a new manifest leaves legacy source data untouched", async (t) => {
  const f = await setup(t);
  assert.ok((await f.registry.list()).some((source) => source.id === "feed"));
  assert.equal((await f.registry.get("feed")).id, "feed");
  const modulePath = join(f.root, "sample.mjs");
  await writeFile(modulePath, moduleText("sample", "Sample"));

  const registered = await f.registry.register(modulePath);
  const resolvedPath = await realpath(modulePath);
  assert.deepEqual(registered, { id: "sample", name: "Sample", modulePath: resolvedPath });
  assert.deepEqual(
    (await f.registry.list()).map((source) => source.id),
    ["feed", "sample"],
  );
  assert.deepEqual(JSON.parse(await readFile(join(f.data, "source-modules.json"), "utf8")), {
    version: 1,
    modules: [{ id: "sample", name: "Sample", modulePath: resolvedPath }],
  });
  assert.equal(await readFile(join(f.data, "source-registry.json"), "utf8"), f.legacy.registry);
  assert.equal(
    await readFile(join(f.data, "source-state", "retired.json"), "utf8"),
    f.legacy.state,
  );
  assert.equal(
    await readFile(join(f.data, "source-data", "retired", "marker"), "utf8"),
    f.legacy.data,
  );
  const reopened = new SourceRegistry({ root: f.data });
  assert.equal((await reopened.get("sample")).id, "sample");
});

test("trusted JavaScript and erasable TypeScript modules load with dependencies from their directory", async (t) => {
  const f = await setup(t);
  await writeFile(join(f.root, "package.json"), '{"type":"module"}');
  const plugins = join(f.root, "plugins");
  const dependency = join(plugins, "node_modules", "fixture-source-dep");
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, "package.json"), '{"type":"module","exports":"./index.js"}');
  await writeFile(join(dependency, "index.js"), "export const label = 'Resolved dependency';\n");
  await mkdir(plugins, { recursive: true });
  const javascriptPath = join(plugins, "sample.js");
  const typescriptPath = join(plugins, "typed.ts");
  await writeFile(
    javascriptPath,
    `import { label } from 'fixture-source-dep';
export default { id: 'javascript', name: label, description: 'Harmless module metadata', async fetch() { return { items: [], issues: [] }; } };`,
  );
  await writeFile(
    typescriptPath,
    `type Input = { url: string; limit: number };
export default { id: 'typescript', name: 'Typed', async fetch(_input: Input) { return { items: [], issues: [] }; } };`,
  );

  await f.registry.register(javascriptPath);
  await f.registry.register(typescriptPath);
  assert.equal((await f.registry.get("javascript")).name, "Resolved dependency");
  assert.equal((await f.registry.get("typescript")).name, "Typed");
});

test("registration, listing and lookup validate modules without calling fetch", async (t) => {
  const f = await setup(t);
  const calls = join(f.root, "fetch-calls");
  const modulePath = join(f.root, "counted.mjs");
  await writeFile(
    modulePath,
    `import { appendFile } from 'node:fs/promises';
export default { id: 'counted', name: 'Counted', async fetch() { await appendFile(${JSON.stringify(calls)}, 'fetch\\n'); return { items: [], issues: [] }; } };`,
  );
  await f.registry.register(modulePath);
  await f.registry.list();
  const module = await f.registry.get("counted");
  await assert.rejects(readFile(calls), { code: "ENOENT" });
  await module.fetch(
    { url: "https://example.com/feed", limit: 1 },
    { signal: new AbortController().signal },
  );
  assert.equal(await readFile(calls, "utf8"), "fetch\n");
});

test("duplicate IDs and invalid external manifests are rejected without replacing registrations", async (t) => {
  const f = await setup(t);
  const firstPath = join(f.root, "first.mjs");
  const duplicatePath = join(f.root, "duplicate.mjs");
  const invalidPath = join(f.root, "invalid.mjs");
  await writeFile(firstPath, moduleText("shared", "First"));
  await writeFile(duplicatePath, moduleText("shared", "Second"));
  await writeFile(invalidPath, "export default { id: 'invalid', name: 'Missing fetch' };");

  const registrations = await Promise.allSettled([
    f.registry.register(firstPath),
    f.registry.register(duplicatePath),
  ]);
  assert.equal(registrations.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(registrations.filter((result) => result.status === "rejected").length, 1);
  await assert.rejects(f.registry.register(invalidPath), /invalid source module/i);
  assert.ok(["First", "Second"].includes((await f.registry.get("shared")).name));
  assert.equal((await f.registry.list()).filter((source) => source.id === "shared").length, 1);
  await assert.rejects(f.registry.register(firstPath), /already registered/i);
  await assert.rejects(f.registry.register(join(f.root, "missing.mjs")), /resolve source module/i);
  await assert.rejects(
    f.registry.register(join(f.root, "not-a-module.txt")),
    /\.mjs, \.js, or \.ts/i,
  );
  await assert.rejects(f.registry.get("unknown"), /unknown source/i);
});

test("removing an external registration preserves its file and all legacy source state", async (t) => {
  const f = await setup(t);
  const modulePath = join(f.root, "remove-me.mjs");
  await writeFile(modulePath, moduleText("remove-me"));
  await f.registry.register(modulePath);
  await f.registry.remove("remove-me");

  assert.ok((await f.registry.list()).some((source) => source.id === "feed"));
  assert.ok(!(await f.registry.list()).some((source) => source.id === "remove-me"));
  assert.equal(await readFile(modulePath, "utf8"), moduleText("remove-me"));
  await assert.rejects(f.registry.remove("feed"), /built-in source/i);
  await assert.rejects(f.registry.remove("unknown"), /unknown source/i);
  assert.equal(await readFile(join(f.data, "source-registry.json"), "utf8"), f.legacy.registry);
  assert.equal(
    await readFile(join(f.data, "source-state", "retired.json"), "utf8"),
    f.legacy.state,
  );
  assert.equal(
    await readFile(join(f.data, "source-data", "retired", "marker"), "utf8"),
    f.legacy.data,
  );
});

test("a malformed source-modules manifest fails with a useful error and stays intact", async (t) => {
  const f = await setup(t);
  const manifestPath = join(f.data, "source-modules.json");
  await mkdir(f.data, { recursive: true });
  await writeFile(manifestPath, "{broken json");

  await assert.rejects(f.registry.list(), /source-modules\.json.*valid JSON/i);
  assert.equal(await readFile(manifestPath, "utf8"), "{broken json");
});
