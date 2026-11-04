import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, wrapRegisteredTools } from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { SQLiteContentLibrary } from "../../src/library/store.ts";
import { registerSources } from "../../src/pi/sources.ts";
import { mockPages } from "../helpers/page-harness.mjs";
import { createSearchHarness } from "../helpers/search-harness.mjs";

const sources = [
  { name: "Science desk", url: "https://example.com/science", enabled: true },
  { name: "Culture desk", url: "https://example.com/culture", enabled: true },
];

function feed(id) {
  return `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
    <item><guid>${id}</guid><title>${id} urban life</title><link>https://example.com/articles/${id}</link>
    <pubDate>Tue, 03 Nov 2026 00:00:00 GMT</pubDate><description>PUBLIC_FEED_SUMMARY</description>
    <content:encoded><![CDATA[<p>LOCAL_READING_BODY ${id}</p>]]></content:encoded></item>
  </channel></rss>`;
}

async function fixture(t, list = sources) {
  const root = await mkdtemp(join(tmpdir(), "pi-current-reading-ui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  await mkdir(data);
  await writeFile(join(data, "sources.json"), JSON.stringify(list));
  const library = new SQLiteContentLibrary(data);
  t.after(() => library.close());
  const harness = await createSearchHarness(t);
  const runtime = harness.loader.getExtensions().runtime;
  const entries = [];
  const original = runtime.appendEntry;
  runtime.appendEntry = (name, value) => entries.push({ name, value });
  t.after(() => {
    runtime.appendEntry = original;
  });
  const extension = await loadExtensionFromFactory(
    (pi) => registerSources(pi, { root: data, library }),
    harness.cwd,
    createEventBus(),
    runtime,
  );
  const tools = wrapRegisteredTools([...extension.tools.values()], harness.runner);
  const find = tools.find((tool) => tool.name === "current_reading_find");
  assert.ok(find, "Pi exposes reading discovery");
  return { entries, extension, library, runtime, find, tools, data };
}

test("Pi reading discovery saves ordered results and displays source/date/matches locally", async (t) => {
  const { requests } = mockPages(t, {
    response: ({ url }) => ({
      body: feed(url.pathname.slice(1)),
      headers: { "content-type": "application/rss+xml" },
    }),
  });
  const f = await fixture(t);
  assert.ok(f.extension.commands.has("source"));
  const result = await f.find.execute("reading", { terms: ["urban life"], limit: 2 });
  assert.equal(result.structuredContent.status, "saved");
  assert.equal(result.structuredContent.count, 2);
  assert.equal(requests.length, 2);
  const repeated = await f.find.execute("again", { terms: ["urban life"], limit: 2 });
  assert.equal(requests.length, 4, "another recommendation checks sources again");
  assert.deepEqual(repeated.structuredContent.references, result.structuredContent.references);
  assert.doesNotMatch(
    JSON.stringify(result),
    /LOCAL_READING_BODY|PUBLIC_FEED_SUMMARY|science urban life/,
  );
  const references = result.structuredContent.references;
  const first = await f.library.read(references[0]);
  assert.equal(first.title, "science urban life");
  assert.match(first.text, /LOCAL_READING_BODY/);
  assert.equal(f.entries[0].value.title, "1. science urban life");
  assert.match(f.entries[0].value.body, /Science desk/);
  assert.match(f.entries[0].value.body, /2026-11-03/);
  assert.match(f.entries[0].value.body, /Matched: urban life/);
  const read = f.tools.find((tool) => tool.name === "current_library_read");
  const opened = await read.execute("read", references[0]);
  assert.equal(opened.structuredContent.count, 1);
  assert.doesNotMatch(JSON.stringify(opened), /LOCAL_READING_BODY/);
});

test("Pi guides an empty source list to /source without acquiring content", async (t) => {
  const { requests } = mockPages(t);
  const f = await fixture(t, []);
  const result = await f.find.execute("reading", {});
  assert.equal(result.structuredContent.count, 0);
  assert.match(result.structuredContent.message, /\/source/);
  assert.equal(requests.length, 0);
});

test("Pi returns saved references with source-labeled acquisition failures", async (t) => {
  mockPages(t, {
    response: ({ url }) =>
      url.pathname === "/culture"
        ? { status: 503, body: "UPSTREAM_ERROR_BODY" }
        : { body: feed("science"), headers: { "content-type": "application/rss+xml" } },
  });
  const f = await fixture(t);
  const result = await f.find.execute("reading", {});
  assert.equal(result.structuredContent.count, 1);
  assert.equal(result.structuredContent.status, "partial");
  assert.equal(result.structuredContent.sourceIssues[0].source, "Culture desk");
  assert.doesNotMatch(JSON.stringify(result), /UPSTREAM_ERROR_BODY|LOCAL_READING_BODY/);
});

test("reading receipt retains acknowledged saves when local presentation fails", async (t) => {
  mockPages(t, {
    response: () => ({ body: feed("science"), headers: { "content-type": "application/rss+xml" } }),
  });
  const f = await fixture(t, [sources[0]]);
  f.runtime.appendEntry = () => {
    throw new Error("Local display unavailable");
  };
  const result = await f.find.execute("reading", {});
  assert.equal(result.structuredContent.count, 1);
  assert.equal(result.structuredContent.status, "saved");
  assert.match(result.structuredContent.message, /prepared.*local library/i);
  assert.match(result.structuredContent.message, /local card/i);
  assert.ok(await f.library.read(result.structuredContent.references[0]));
});

test("real Pi session hooks prepare in the background and recommendation shares that work", async (t) => {
  const { requests } = mockPages(t, {
    response: ({ url }) => ({
      body: feed(url.pathname.slice(1)),
      headers: { "content-type": "application/rss+xml" },
    }),
  });
  const f = await fixture(t);
  const statuses = [];
  const context = { hasUI: true, ui: { setStatus: (...args) => statuses.push(args) } };
  const shutdown = async () => {
    for (const handler of f.extension.handlers.get("session_shutdown") ?? [])
      await handler({ type: "session_shutdown", reason: "reload" }, context);
  };
  t.after(shutdown);
  for (const handler of f.extension.handlers.get("session_start") ?? [])
    await handler({ type: "session_start", reason: "startup" }, context);
  const result = await f.find.execute("recommend", {});
  assert.equal(result.structuredContent.count, 2);
  assert.equal(requests.length, 2);
  assert.ok(
    statuses.some(([, value]) => /Checked 2 source.*processed 2 article/.test(value ?? "")),
  );
  await shutdown();
  for (const handler of f.extension.handlers.get("session_start") ?? [])
    await handler({ type: "session_start", reason: "reload" }, context);
  await f.find.execute("recommend-again", {});
  assert.equal(requests.length, 4, "reload checks the configured sources again");
});

test("a /source change controls the next reading request through the registered Pi boundary", async (t) => {
  const { requests } = mockPages(t, {
    response: ({ url }) => ({
      body: feed(url.pathname.slice(1)),
      headers: { "content-type": "application/rss+xml" },
    }),
  });
  const f = await fixture(t);
  let step = 0;
  await f.extension.commands.get("source").handler("", {
    hasUI: true,
    mode: "tui",
    ui: {
      async select(_title, choices) {
        if (step++ === 0) return choices.find((choice) => choice.includes("Science desk"));
        if (step === 2) return choices.find((choice) => /disable/i.test(choice));
        return undefined;
      },
      notify() {},
    },
  });
  const result = await f.find.execute("reading", {});
  assert.equal(result.structuredContent.count, 1);
  assert.deepEqual(
    requests.map(({ url }) => url.href),
    [sources[1].url],
  );
  assert.equal(
    (await f.library.read(result.structuredContent.references[0])).title,
    "culture urban life",
  );
});
