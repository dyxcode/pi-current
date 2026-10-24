import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SourceRegistry } from "../src/sources/registry.ts";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "current-plugins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new SourceRegistry({ root: join(root, "data") });
  t.after(() => registry.close());
  async function plugin(id, body = "") {
    const path = join(root, `${id}.mjs`);
    await writeFile(
      path,
      `import { appendFile, mkdir } from 'node:fs/promises';
 export default {apiVersion:1,id:${JSON.stringify(id)},name:${JSON.stringify(id.toUpperCase())},hosts:['example.com'],capabilities:{login:true,check:true,read:true,collect:false},async create(ctx){
 await mkdir(ctx.dataDir,{recursive:true}); const mark=async x=>appendFile(ctx.dataDir+'/calls',x+'\\n');
 return {async login(){await mark('login');},async check(){await mark('check');return 'ready';},async read(url,max,signal){await mark('read');${body}return {sourceId:${JSON.stringify(id)},externalId:'1',url,title:'PRIVATE_TITLE',text:'PRIVATE_BODY',retrievedAt:new Date().toISOString(),sourceCompleteness:'unknown',truncated:false};},async close(){}};}};`,
    );
    return path;
  }
  return { root, registry, plugin };
}
test("register, list and restart never create an adapter; duplicate IDs do not overwrite", async (t) => {
  const f = await fixture(t);
  const a = await f.plugin("alpha");
  const b = await f.plugin("beta");
  await f.registry.register(a);
  await f.registry.register(b);
  assert.deepEqual(
    (await f.registry.list()).map((s) => s.id),
    ["alpha", "beta"],
  );
  await assert.rejects(readFile(join(f.root, "data/source-data/alpha/calls")), /ENOENT/);
  await assert.rejects(f.registry.register(a), /SOURCE_ALREADY_REGISTERED/);
  await f.registry.close();
  const second = new SourceRegistry({ root: join(f.root, "data") });
  t.after(() => second.close());
  assert.equal((await second.list()).length, 2);
});
test("one broken plugin is isolated and removing it preserves state and files", async (t) => {
  const f = await fixture(t);
  const a = await f.plugin("alpha");
  const b = await f.plugin("beta");
  await f.registry.register(a);
  await f.registry.register(b);
  await f.registry.login("alpha");
  await writeFile(b, 'throw new Error("PRIVATE_SECRET");');
  const states = await f.registry.list();
  assert.equal(states.find((x) => x.id === "beta").problem, "PLUGIN_LOAD_FAILED");
  assert.ok(!JSON.stringify(states).includes("PRIVATE_SECRET"));
  await f.registry.remove("alpha");
  assert.equal((await f.registry.list()).length, 1);
  assert.equal(await readFile(join(f.root, "data/source-data/alpha/calls"), "utf8"), "login\n");
});
test("capability mismatch fails closed; failures pause only their own source and never retry", async (t) => {
  const f = await fixture(t);
  await f.registry.register(await f.plugin("alpha", 'throw new Error("ACCESS_DENIED");'));
  await f.registry.register(await f.plugin("beta"));
  await assert.rejects(f.registry.read("alpha", "https://example.com/a", 2000), /ACCESS_DENIED/);
  await assert.rejects(f.registry.read("alpha", "https://example.com/a", 2000), /ACCESS_DENIED/);
  assert.equal(await readFile(join(f.root, "data/source-data/alpha/calls"), "utf8"), "read\n");
  assert.equal((await f.registry.read("beta", "https://example.com/a", 2000)).text, "PRIVATE_BODY");
  await f.registry.login("alpha");
  assert.equal((await f.registry.list()).find((x) => x.id === "alpha").pause, "ACCESS_DENIED");
  await f.registry.check("alpha");
  assert.equal((await f.registry.list()).find((x) => x.id === "alpha").pause, undefined);
});
test("disabled sources cannot fetch, URL ownership is enforced, and removal retains the pause", async (t) => {
  const f = await fixture(t);
  const path = await f.plugin("alpha", 'throw new Error("RATE_LIMITED");');
  await f.registry.register(path);
  await assert.rejects(
    f.registry.read("alpha", "https://different.example/a", 2000),
    /SOURCE_URL_MISMATCH/,
  );
  await f.registry.setEnabled("alpha", false);
  await assert.rejects(f.registry.read("alpha", "https://example.com/a", 2000), /SOURCE_DISABLED/);
  await f.registry.setEnabled("alpha", true);
  await assert.rejects(f.registry.read("alpha", "https://example.com/a", 2000), /RATE_LIMITED/);
  await f.registry.remove("alpha");
  await f.registry.register(path);
  assert.equal((await f.registry.list())[0].pause, "RATE_LIMITED");
});
test("automatic URL routing ignores disabled registrations", async (t) => {
  const f = await fixture(t);
  await f.registry.register(await f.plugin("alpha"));
  await f.registry.register(await f.plugin("beta"));
  await f.registry.setEnabled("alpha", false);
  assert.equal(await f.registry.resolve("https://example.com/a"), "beta");
});
test("a factory with mismatched capabilities is closed without starting an operation", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "invalid.mjs");
  await writeFile(
    path,
    `import {writeFile} from 'node:fs/promises';export default {apiVersion:1,id:'invalid',name:'Invalid',hosts:[],capabilities:{login:true,check:false,read:false,collect:false},async create(ctx){return {async close(){await writeFile(ctx.dataDir+'/closed','yes')}}}}`,
  );
  await f.registry.register(path);
  await assert.rejects(f.registry.login("invalid"), /PLUGIN_INVALID/);
  assert.equal(await readFile(join(f.root, "data/source-data/invalid/closed"), "utf8"), "yes");
});
test("cancelled work cannot publish and a busy source does not start a second read", async (t) => {
  const f = await fixture(t);
  await f.registry.register(
    await f.plugin(
      "alpha",
      `await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('CANCELLED')),{once:true}));`,
    ),
  );
  const controller = new AbortController();
  const pending = f.registry.read("alpha", "https://example.com/a", 2000, controller.signal);
  const rejection = assert.rejects(pending, /CANCELLED/);
  await assert.rejects(f.registry.read("alpha", "https://example.com/a", 2000), /SOURCE_BUSY/);
  controller.abort();
  await rejection;
});
test("partial collection preserves acquired items and persists the failure pause", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, "partial.mjs");
  await writeFile(
    path,
    `export default {apiVersion:1,id:'partial',name:'Partial',hosts:['example.com'],capabilities:{login:false,check:false,read:false,collect:true},async create(){return {async collect(){return {items:[{sourceId:'partial',externalId:'one',url:'https://example.com/a',title:'Fixture',text:'Fixture',retrievedAt:new Date().toISOString(),sourceCompleteness:'unknown',truncated:false}],failures:[{externalId:'two',code:'RATE_LIMITED'}],stopReason:'complete'}},async close(){}}}};`,
  );
  await f.registry.register(path);
  const result = await f.registry.collect("partial", 3);
  assert.equal(result.items.length, 1);
  assert.equal(result.stopReason, "RATE_LIMITED");
  assert.equal((await f.registry.list())[0].pause, "RATE_LIMITED");
  await assert.rejects(f.registry.collect("partial", 3), /RATE_LIMITED/);
});
test("a plugin with a stalled async import does not block the other source rows", async (t) => {
  const f = await fixture(t);
  const path = await f.plugin("alpha");
  await f.registry.register(path);
  await f.registry.register(await f.plugin("beta"));
  await writeFile(
    path,
    `await new Promise(resolve=>setTimeout(resolve,5500));throw new Error('PRIVATE_IMPORT_FAILURE');`,
  );
  const started = Date.now();
  const rows = await f.registry.list();
  assert.ok(Date.now() - started < 5300);
  assert.equal(rows.find((r) => r.id === "alpha").problem, "PLUGIN_LOAD_FAILED");
  assert.equal(rows.find((r) => r.id === "beta").problem, undefined);
});
