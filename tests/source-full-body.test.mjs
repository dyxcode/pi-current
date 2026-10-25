import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createEventBus, wrapRegisteredTools } from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { registerSources } from "../src/pi/sources.ts";
import { MAX_ARTICLE_BYTES } from "../src/sources/content-limits.mjs";
import { sourceHarness, sourcePlugin } from "./helpers/source-harness.mjs";
import { createSearchHarness } from "./helpers/search-harness.mjs";

const digest = (text) => createHash("sha256").update(text).digest("hex");

function plugin({ count = 1, body = '"中文🙂内容 ".repeat(12000)', summary = true } = {}) {
  return `export default {
    apiVersion:1,id:'sample',name:'Sample',hosts:['example.com'],
    capabilities:{login:false,check:false,read:false,collect:false},
    connections:[{id:'access',name:'Access',login:false,check:false}],
    operations:[
      {id:'read',name:'Read',kind:'read',connection:'access',input:'url'},
      {id:'fetch-search',name:'Fetch search',kind:'acquire',connection:'access',input:'query'}
    ],
    async create(){return {async close(){},async perform(operation){
      const items=Array.from({length:operation==='read'?1:${count}},(_,index)=>({
        sourceId:'sample',externalId:String(index),url:'https://example.com/a-'+index,
        title:'Article '+index,${summary ? "summary:'SOURCE_SUMMARY'," : ""}
        text:${body}+' TAILTOKEN'+index,
        retrievedAt:'2026-01-01T00:00:00Z',sourceCompleteness:'unknown',truncated:false
      }));
      return {kind:'content',batch:{items,failures:[],stopReason:'complete'}};
    }}}};`;
}

test("the real Pi operation tool saves every whole article despite a smaller presentation preference", async (t) => {
  const f = await sourceHarness(t, { plugin: plugin({ count: 6 }) });
  await f.registry.register(f.modulePath);
  const h = await createSearchHarness(t);
  const extension = await loadExtensionFromFactory(
    (pi) => registerSources(pi, { root: f.data, registry: f.registry, library: f.library }),
    h.cwd,
    createEventBus(),
    h.loader.getExtensions().runtime,
  );
  h.loader.getExtensions().runtime.appendEntry = (name, data) => f.entries.push({ name, data });
  const wrapped = wrapRegisteredTools([...extension.tools.values()], h.runner);
  for (const handler of extension.handlers.get("input") ?? [])
    await handler(
      {
        type: "input",
        text: "Fetch and save 6 items from sample search: tools",
        source: "interactive",
      },
      {},
    );
  const result = await wrapped
    .find((tool) => tool.name === "current_source_operation")
    .execute("fetch", {
      source: "sample",
      operation: "fetch-search",
      query: "tools",
      limit: 6,
      maxCharacters: 1000,
      save: true,
    });
  assert.equal(result.structuredContent.references.length, 6);
  const saved = await f.library.latest("sample");
  assert.equal(saved.items.length, 6, "saving must not drop later articles to fit a text budget");
  for (let index = 0; index < saved.items.length; index++) {
    const article = saved.items[index];
    assert.equal(
      digest(article.text),
      digest(`${"中文🙂内容 ".repeat(12000)} TAILTOKEN${article.externalId}`),
    );
    assert.equal(article.summary, "SOURCE_SUMMARY");
    assert.equal(article.truncated, false);
  }
  assert.equal((await f.library.search({ query: "TAILTOKEN5" })).length, 1);
  assert.ok(!JSON.stringify(result).includes("TAILTOKEN"));
  assert.ok(!JSON.stringify(f.entries).includes("TAILTOKEN"), "local cards retain previews only");
});

test("direct reading retains a whole body for a separately authorized later save", async (t) => {
  const f = await sourceHarness(t, { plugin: plugin() });
  await f.registry.register(f.modulePath);
  await f.emit("input", {
    text: "Read https://example.com/a-0 from sample",
    source: "interactive",
  });
  const result = await f.api.read("https://example.com/a-0", 1000);
  assert.equal(await f.library.latest("sample"), undefined);
  await f.emit("input", { text: "Save last fetched content", source: "interactive" });
  const saved = await f.tools.get("current_source_save").execute("save", {
    pendingRef: result.structuredContent.pendingRef,
  });
  assert.equal(saved.structuredContent.references.length, 1);
  assert.equal(
    digest((await f.library.latest("sample")).items[0].text),
    digest(`${"中文🙂内容 ".repeat(12000)} TAILTOKEN0`),
  );
});

test("legacy source reads retain their argument contract while preserving returned long bodies", async (t) => {
  const f = await sourceHarness(t, {
    plugin: sourcePlugin()
      .replace('"PRIVATE_BODY"', '"x".repeat(12000)+" LEGACYTAIL"')
      .replace(
        "async read(url) {",
        "async read(url, max) { if(max!==1000)throw new Error('SOURCE_INVALID_INPUT');",
      ),
  });
  await f.registry.register(f.modulePath);
  const article = await f.registry.read("sample", "https://example.com/a", 1000);
  assert.equal(article.text, `${"x".repeat(12000)} LEGACYTAIL`);
  assert.equal(article.truncated, false);
});

test("an article over the byte ceiling fails without a saved prefix", async (t) => {
  const f = await sourceHarness(t, {
    plugin: plugin({ body: `"界".repeat(${Math.floor(MAX_ARTICLE_BYTES / 3) + 1})` }),
  });
  await f.registry.register(f.modulePath);
  await assert.rejects(
    f.registry.perform("sample", "read", {
      url: "https://example.com/a-0",
      limit: 1,
      maxRequests: 1,
      maxCharacters: 1000,
    }),
    /SOURCE_INVALID_RESULT|RESPONSE_TOO_LARGE/,
  );
  assert.equal(await f.library.latest("sample"), undefined);
});
