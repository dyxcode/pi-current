import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, wrapRegisteredTools } from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { SQLiteContentLibrary } from "../../src/library/store.ts";
import { registerSources } from "../../src/pi/sources.ts";
import { readSources } from "../../src/reading/sources.ts";
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

function website(feeds) {
  const links = feeds
    .map(
      ({ title, type = "application/rss+xml", url }) =>
        `<link rel="alternate" type="${type}" title="${title}" href="${url}">`,
    )
    .join("");
  return `<!doctype html><html><head><title>Synthetic publication</title>${links}</head><body>Fixture homepage</body></html>`;
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

test("Pi adds a verified source through conversation and prepares it for reading", async (t) => {
  mockPages(t, {
    response: () => ({ body: feed("new"), headers: { "content-type": "application/rss+xml" } }),
  });
  const f = await fixture(t, []);
  const add = f.tools.find((tool) => tool.name === "current_source_add");
  assert.ok(add, "Pi exposes conversational source addition");
  let prepared;
  const background = new Promise((resolve) => {
    prepared = resolve;
  });
  const context = {
    hasUI: true,
    ui: {
      setStatus: (_key, value) => {
        if (/processed 1 article/.test(value ?? "")) prepared();
      },
    },
  };
  t.after(async () => {
    for (const handler of f.extension.handlers.get("session_shutdown") ?? [])
      await handler({ type: "session_shutdown", reason: "reload" }, context);
  });
  for (const handler of f.extension.handlers.get("session_start") ?? [])
    await handler({ type: "session_start", reason: "startup" }, context);
  const result = await add.execute("add", { name: "New source", url: "https://example.com/feed" });
  assert.equal(result.structuredContent.added, true);
  assert.deepEqual(await readSources(f.data), [
    { name: "New source", url: "https://example.com/feed", enabled: true },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /LOCAL_READING_BODY|PUBLIC_FEED_SUMMARY/);
  await background;
  assert.equal((await f.library.search({ query: "urban life" })).length, 1);
  const reading = await f.find.execute("recommend", {});
  assert.equal(reading.structuredContent.count, 1);
  const saved = await f.library.read(reading.structuredContent.references[0]);
  assert.equal(saved.title, "new urban life");
});

test("Pi resolves a website's single feed and recommends its prepared articles", async (t) => {
  const homepageUrl = "https://example.com/journal";
  const feedUrl = "https://example.com/journal/feed.xml";
  const { requests } = mockPages(t, {
    response: ({ url }) =>
      url.href === homepageUrl
        ? { body: website([{ title: "Journal feed", url: "/journal/feed.xml" }]) }
        : { body: feed("journal"), headers: { "content-type": "application/rss+xml" } },
  });
  const f = await fixture(t, []);
  const add = f.tools.find((tool) => tool.name === "current_source_add");
  assert.ok(add);
  let prepared;
  const background = new Promise((resolve) => {
    prepared = resolve;
  });
  const context = {
    hasUI: true,
    ui: {
      setStatus: (_key, value) => {
        if (/processed 1 article/.test(value ?? "")) prepared();
      },
    },
  };
  t.after(async () => {
    for (const handler of f.extension.handlers.get("session_shutdown") ?? [])
      await handler({ type: "session_shutdown", reason: "reload" }, context);
  });
  for (const handler of f.extension.handlers.get("session_start") ?? [])
    await handler({ type: "session_start", reason: "startup" }, context);

  const result = await add.execute("add", { name: "Journal", url: homepageUrl });
  assert.deepEqual(result.structuredContent.source, {
    name: "Journal",
    url: feedUrl,
    enabled: true,
  });
  assert.equal(result.structuredContent.added, true);
  assert.deepEqual(await readSources(f.data), [{ name: "Journal", url: feedUrl, enabled: true }]);
  await background;
  const reading = await f.find.execute("recommend", {});
  assert.equal(reading.structuredContent.count, 1);
  assert.equal(
    (await f.library.read(reading.structuredContent.references[0])).title,
    "journal urban life",
  );
  assert.equal(requests.filter(({ url }) => url.href === homepageUrl).length, 1);
  assert.ok(requests.filter(({ url }) => url.href === feedUrl).length >= 2);
});

test("Pi returns multiple website feeds without fetching or saving them, then accepts the selected feed URL", async (t) => {
  const homepageUrl = "https://example.com/multiple";
  const candidates = [
    { title: "Technology", url: "https://example.com/technology.xml" },
    { title: "Culture", url: "https://example.com/culture.atom" },
  ];
  const { requests } = mockPages(t, {
    response: ({ url }) =>
      url.href === homepageUrl
        ? {
            body: website([
              { title: "Technology", url: "/technology.xml" },
              { title: "Culture", type: "application/atom+xml", url: "/culture.atom" },
            ]),
          }
        : { body: feed("selected"), headers: { "content-type": "application/rss+xml" } },
  });
  const f = await fixture(t, []);
  const add = f.tools.find((tool) => tool.name === "current_source_add");
  assert.ok(add);

  const discovery = await add.execute("discover", { name: "Publication", url: homepageUrl });
  assert.deepEqual(discovery.structuredContent.candidates, candidates);
  assert.equal(discovery.structuredContent.added, false);
  assert.equal("source" in discovery.structuredContent, false);
  assert.match(discovery.structuredContent.message, /select a candidate/i);
  assert.deepEqual(await readSources(f.data), []);
  assert.deepEqual(
    requests.map(({ url }) => url.href),
    [homepageUrl],
    "discovery does not fetch any candidate feed",
  );

  const selected = await add.execute("add-selected", {
    name: "Technology",
    url: candidates[0].url,
  });
  assert.equal(selected.structuredContent.added, true);
  assert.deepEqual(selected.structuredContent.source, {
    name: "Technology",
    url: candidates[0].url,
    enabled: true,
  });
  assert.deepEqual(await readSources(f.data), [selected.structuredContent.source]);
  assert.deepEqual(
    requests.map(({ url }) => url.href),
    [homepageUrl, candidates[0].url],
  );
});

test("Pi reports a website with no feed and leaves subscriptions unchanged", async (t) => {
  const homepageUrl = "https://example.com/no-feed";
  const { requests } = mockPages(t, {
    response: () => ({
      body: "<html><head><title>No feed</title></head><body>Nothing here.</body></html>",
    }),
  });
  const f = await fixture(t, []);
  const add = f.tools.find((tool) => tool.name === "current_source_add");
  assert.ok(add);

  const result = await add.execute("discover", { name: "No feed", url: homepageUrl });
  assert.deepEqual(result.structuredContent.candidates, []);
  assert.equal(result.structuredContent.added, false);
  assert.equal("source" in result.structuredContent, false);
  assert.match(result.structuredContent.message, /no rss\/atom feed/i);
  assert.deepEqual(await readSources(f.data), []);
  assert.deepEqual(
    requests.map(({ url }) => url.href),
    [homepageUrl],
  );
});

test("Pi keeps a disabled discovered feed unchanged without validating it", async (t) => {
  const homepageUrl = "https://example.com/disabled-site";
  const feedUrl = "https://example.com/disabled-feed.xml";
  const existing = { name: "Existing", url: feedUrl, enabled: false };
  const { requests } = mockPages(t, {
    response: () => ({ body: website([{ title: "Existing feed", url: "/disabled-feed.xml" }]) }),
  });
  const f = await fixture(t, [existing]);
  const add = f.tools.find((tool) => tool.name === "current_source_add");
  assert.ok(add);

  const result = await add.execute("duplicate", { name: "Renamed", url: homepageUrl });
  assert.equal(result.structuredContent.added, false);
  assert.deepEqual(result.structuredContent.source, existing);
  assert.deepEqual(await readSources(f.data), [existing]);
  assert.deepEqual(
    requests.map(({ url }) => url.href),
    [homepageUrl],
    "a discovered duplicate retains its disabled state without validating the feed",
  );
});

test("Pi shutdown cancels validation of a discovered feed before it can be saved", async (t) => {
  const homepageUrl = "https://example.com/cancel-site";
  const feedUrl = "https://example.com/cancel-feed.xml";
  let validating;
  const validationStarted = new Promise((resolve) => {
    validating = resolve;
  });
  const { requests } = mockPages(t, {
    response: ({ url }) => {
      if (url.href === homepageUrl)
        return { body: website([{ title: "Cancel feed", url: "/cancel-feed.xml" }]) };
      validating();
      return undefined;
    },
  });
  const f = await fixture(t, []);
  const add = f.tools.find((tool) => tool.name === "current_source_add");
  assert.ok(add);
  const pending = add.execute("add", { name: "Cancel", url: homepageUrl });
  const cancelled = assert.rejects(pending, /CANCELLED/);
  await validationStarted;
  assert.deepEqual(
    requests.map(({ url }) => url.href),
    [homepageUrl, feedUrl],
  );
  for (const handler of f.extension.handlers.get("session_shutdown") ?? [])
    await handler({ type: "session_shutdown", reason: "reload" }, { hasUI: false });
  await cancelled;
  assert.deepEqual(await readSources(f.data), []);
});

test("Pi source addition preserves a disabled subscription without fetching", async (t) => {
  const { requests } = mockPages(t);
  const f = await fixture(t, [{ ...sources[0], enabled: false }]);
  const add = f.tools.find((tool) => tool.name === "current_source_add");
  assert.ok(add);
  const result = await add.execute("add", { name: "Renamed", url: sources[0].url });
  assert.equal(result.structuredContent.added, false);
  assert.equal(result.structuredContent.source.enabled, false);
  assert.match(result.structuredContent.message, /\/source/);
  assert.deepEqual(await readSources(f.data), [{ ...sources[0], enabled: false }]);
  assert.equal(requests.length, 0);
});

test("Pi session shutdown cancels source validation without adding a subscription", async (t) => {
  let requested;
  const waiting = new Promise((resolve) => {
    requested = resolve;
  });
  mockPages(t, {
    response: () => {
      requested();
      return undefined;
    },
  });
  const f = await fixture(t, []);
  const add = f.tools.find((tool) => tool.name === "current_source_add");
  assert.ok(add);
  const pending = add.execute("add", { name: "New", url: "https://example.com/feed" });
  const cancelled = assert.rejects(pending, /CANCELLED/);
  await waiting;
  for (const handler of f.extension.handlers.get("session_shutdown") ?? [])
    await handler({ type: "session_shutdown", reason: "reload" }, { hasUI: false });
  await cancelled;
  assert.deepEqual(await readSources(f.data), []);
});

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
