import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, wrapRegisteredTools } from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { SQLiteContentLibrary } from "../../src/library/store.ts";
import { registerSources } from "../../src/pi/sources.ts";
import { openLocalReader } from "../../src/pi/reader.ts";
import { MAX_ARTICLE_BYTES } from "../../src/sources/content-limits.mjs";
import { mockPages, PUBLIC_IP } from "../helpers/page-harness.mjs";
import { createSearchHarness } from "../helpers/search-harness.mjs";

const feedUrl = "https://example.com/feed.xml";

function longBody() {
  return `${Array.from(
    { length: 2_500 },
    (_, index) => `Paragraph ${String(index).padStart(4, "0")} has readable feed content.`,
  ).join("\n")}\nTAILTOKEN`;
}

function rss(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
  <title>Fixture feed</title>
  <item><guid>invalid-entry</guid><title>No article link</title></item>
  <item><guid>article-1</guid><title>Long feed article</title>
    <link>https://example.com/article-1</link>
    <content:encoded><![CDATA[${body}]]></content:encoded>
  </item>
</channel></rss>`;
}

async function piSourceHarness(t) {
  const temporary = await mkdtemp(join(tmpdir(), "pi-current-pi-source-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "data");
  const library = new SQLiteContentLibrary(root);
  t.after(() => library.close());

  const harness = await createSearchHarness(t);
  const runtime = harness.loader.getExtensions().runtime;
  const originalAppendEntry = runtime.appendEntry;
  const entries = [];
  runtime.appendEntry = (name, data) => entries.push({ name, data });
  t.after(() => {
    runtime.appendEntry = originalAppendEntry;
  });

  const extension = await loadExtensionFromFactory(
    (pi) => registerSources(pi, { root, library }),
    harness.cwd,
    createEventBus(),
    runtime,
  );
  const tools = wrapRegisteredTools([...extension.tools.values()], harness.runner);
  return { entries, extension, library, root, runtime, tools };
}

function definition(extension, name) {
  const registered = extension.tools.get(name);
  assert.ok(registered, `Pi registered ${name}`);
  return registered.definition;
}

function readerContext({ rows = 18, onScreen = () => {} } = {}) {
  const tui = {
    terminal: { rows, columns: 80 },
    requestRender() {},
  };
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text };
  const keybindings = {
    matches(data, binding) {
      if (binding === "tui.altScreen.pageDown") return data === "pagedown";
      if (binding === "tui.altScreen.pageUp") return data === "pageup";
      if (binding === "tui.editor.cursorDown") return data === "down";
      if (binding === "tui.editor.cursorUp") return data === "up";
      if (binding === "tui.select.cancel") return data === "escape";
      return false;
    },
  };
  const ui = {
    async custom(factory) {
      return new Promise((resolve) => {
        const component = factory(tui, theme, keybindings, resolve);
        onScreen(component);
      });
    },
  };
  return { hasUI: true, mode: "tui", ui };
}

test("real Pi import saves a full built-in feed item and keeps body local across tools", async (t) => {
  const body = longBody();
  const fixture = rss(body);
  const { requests, lookups } = mockPages(t, {
    lookup: async () => [{ address: PUBLIC_IP, family: 4 }],
    response(record) {
      assert.equal(record.url.href, feedUrl);
      return {
        body: fixture,
        headers: { "content-type": "application/rss+xml; charset=utf-8" },
      };
    },
  });
  const f = await piSourceHarness(t);

  const imported = await f.tools
    .find((tool) => tool.name === "current_source_import")
    .execute("feed-import", { url: feedUrl });
  assert.equal(imported.structuredContent.count, 1);
  assert.match(imported.structuredContent.source, /^feed-[a-f0-9]{40}$/);
  assert.equal(imported.structuredContent.references.length, 1);
  assert.deepEqual(imported.structuredContent.issues, [
    { index: 0, message: "The entry has no usable HTTP(S) article URL." },
  ]);
  assert.doesNotMatch(JSON.stringify(imported), /Long feed article|Paragraph 0000|TAILTOKEN/);
  assert.doesNotMatch(JSON.stringify(imported), /Long feed article|PRIVATE_FEED_BODY/);
  const localIssues = f.entries.find((entry) => entry.data.title === "Source import issues");
  assert.ok(localIssues, "Pi retained detailed source issues in a local card");
  assert.match(localIssues.data.body, /Entry 0: The entry has no usable HTTP\(S\) article URL\./);
  assert.equal(requests.length, 1, "Pi import fetches the feed once");
  assert.equal(lookups.length, 1, "the synthetic public host is resolved once");

  const { itemId, versionId } = imported.structuredContent.references[0];
  const saved = await f.library.read({ itemId, versionId, maxCharacters: MAX_ARTICLE_BYTES });
  assert.equal(saved.text, body, "the database retained the complete feed body");
  assert.equal(saved.displayTruncated, false);

  const searched = await f.tools
    .find((tool) => tool.name === "current_library_search")
    .execute("search-tail", { query: "TAILTOKEN" });
  assert.deepEqual(searched.structuredContent.references, [{ itemId, versionId }]);
  assert.doesNotMatch(JSON.stringify(searched), /Long feed article|Paragraph 0000|TAILTOKEN/);
  assert.ok(f.entries.length > 0, "Pi displayed a local preview card");
  for (const entry of f.entries) {
    const preview = /Body preview: ([^\n]*)/.exec(entry.data.body)?.[1];
    if (preview) assert.ok([...preview].length <= 200, "cards cap body previews at 200 codepoints");
  }

  let displayed = "";
  const context = readerContext({
    rows: 18,
    onScreen(component) {
      const firstPage = component.render(72).join("\n");
      assert.doesNotMatch(firstPage, /TAILTOKEN/, "the tail is below the first reader page");
      for (let page = 0; page < 300; page++) component.handleInput("pagedown");
      displayed = component.render(72).join("\n");
      component.handleInput("escape");
    },
  });
  const read = await definition(f.extension, "current_library_read").execute(
    "local-read",
    { itemId, versionId },
    undefined,
    undefined,
    context,
  );
  assert.match(displayed, /TAILTOKEN/, "the actual Pi TUI reader exposes the full-body tail");
  assert.equal(displayed.includes("\u001b["), false, "reader output is plain escaped text");
  assert.deepEqual(read.structuredContent.references, [{ itemId, versionId }]);
  assert.doesNotMatch(JSON.stringify(read), /Long feed article|Paragraph 0000|TAILTOKEN/);
  assert.equal(
    JSON.stringify(f.entries).includes(JSON.stringify(body).slice(1, -1)),
    false,
    "session cards never retain the complete body",
  );

  const removed = await f.tools
    .find((tool) => tool.name === "current_library_remove")
    .execute("delete-item", { itemId });
  assert.equal(removed.structuredContent.status, "removed");
  assert.deepEqual(await f.library.read({ itemId }), undefined);
  assert.doesNotMatch(JSON.stringify(removed), /TAILTOKEN|Paragraph 0000/);
});

test("real Pi import defaults to five feed items and does not fetch their article links", async (t) => {
  const items = Array.from(
    { length: 6 },
    (_, index) =>
      `<item><guid>default-${index}</guid><title>Default ${index}</title><link>https://example.com/article-${index}</link><description>Feed text ${index}</description></item>`,
  ).join("\n");
  const fixture = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>${items}</channel></rss>`;
  const { requests, lookups } = mockPages(t, {
    lookup: async () => [{ address: PUBLIC_IP, family: 4 }],
    response: () => ({
      body: fixture,
      headers: { "content-type": "application/rss+xml; charset=utf-8" },
    }),
  });
  const f = await piSourceHarness(t);
  const imported = await f.tools
    .find((tool) => tool.name === "current_source_import")
    .execute("default-limit", { url: feedUrl });

  assert.equal(imported.structuredContent.count, 5);
  assert.equal(imported.structuredContent.references.length, 5);
  assert.equal((await f.library.latest()).items.length, 5);
  assert.equal(requests.length, 1, "Pi fetched the feed once and did not fetch linked articles");
  assert.equal(lookups.length, 1);
});

test("without an interactive TUI, library read reports unread and keeps the body out of results", async (t) => {
  const { requests, lookups } = mockPages(t, {
    lookup: async () => [{ address: PUBLIC_IP, family: 4 }],
    response: () => ({
      body: rss(longBody()),
      headers: { "content-type": "application/rss+xml; charset=utf-8" },
    }),
  });
  const f = await piSourceHarness(t);
  const imported = await f.tools
    .find((tool) => tool.name === "current_source_import")
    .execute("import", { url: feedUrl, limit: 5 });
  const reference = imported.structuredContent.references[0];
  const result = await definition(f.extension, "current_library_read").execute(
    "non-interactive-read",
    reference,
    undefined,
    undefined,
    {
      mode: "rpc",
      hasUI: false,
      ui: {
        async custom() {
          throw new Error("a non-interactive read must not open a reader");
        },
      },
    },
  );
  assert.equal(result.structuredContent.status, "unread");
  assert.deepEqual(result.structuredContent.references, [reference]);
  assert.doesNotMatch(JSON.stringify(result), /Long feed article|Paragraph 0000|TAILTOKEN/);
  assert.equal(requests.length, 1);
  assert.equal(lookups.length, 1);
});

test("source import exposes a useful parsing failure without returning feed evidence", async (t) => {
  const { requests, lookups } = mockPages(t, {
    lookup: async () => [{ address: PUBLIC_IP, family: 4 }],
    response: () => ({
      body: "<html><title>Login</title><body>PRIVATE_FEED_ERROR_BODY</body></html>",
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  });
  const f = await piSourceHarness(t);
  const notices = [];
  const result = await definition(f.extension, "current_source_import").execute(
    "bad-feed",
    { url: feedUrl },
    undefined,
    undefined,
    { hasUI: true, ui: { notify: (...args) => notices.push(args) } },
  );
  assert.equal(result.structuredContent.status, "failed");
  assert.match(result.structuredContent.message, /UNSUPPORTED_CONTENT.*RSS or Atom/i);
  assert.match(notices[0][0], /import failed:.*UNSUPPORTED_CONTENT.*RSS or Atom/i);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FEED_ERROR_BODY|Login/);
  assert.equal(await f.library.latest(), undefined);
  assert.equal(requests.length, 1);
  assert.equal(lookups.length, 1);
});

test("Pi bounds useful feed issues and keeps item bodies out of the receipt", async (t) => {
  const issueEntries = Array.from(
    { length: 25 },
    (_, index) => `<item><guid>issue-${index}</guid><title>Invalid entry ${index}</title></item>`,
  ).join("\n");
  const fixture = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>${issueEntries}</channel></rss>`;
  mockPages(t, {
    lookup: async () => [{ address: PUBLIC_IP, family: 4 }],
    response: () => ({
      body: fixture,
      headers: { "content-type": "application/rss+xml; charset=utf-8" },
    }),
  });
  const f = await piSourceHarness(t);
  const result = await f.tools
    .find((tool) => tool.name === "current_source_import")
    .execute("bounded-issues", { url: feedUrl });

  assert.equal(result.structuredContent.status, "partial");
  assert.equal(result.structuredContent.count, 0);
  assert.equal(result.structuredContent.issues.length, 20);
  assert.deepEqual(result.structuredContent.issues[0], {
    index: 0,
    message: "The entry has no usable HTTP(S) article URL.",
  });
  assert.ok(result.structuredContent.issues.every(({ message }) => [...message].length <= 200));
  assert.doesNotMatch(JSON.stringify(result), /Invalid entry 0|PRIVATE/);

  const localIssues = f.entries.find((entry) => entry.data.title === "Source import issues");
  assert.ok(localIssues);
  assert.equal((localIssues.data.body.match(/^Entry /gm) ?? []).length, 20);
  assert.doesNotMatch(localIssues.data.body, /Invalid entry 0|PRIVATE/);
});

test("a local card failure does not hide the acknowledged library save", async (t) => {
  mockPages(t, {
    lookup: async () => [{ address: PUBLIC_IP, family: 4 }],
    response: () => ({
      body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title><item><guid>saved-before-card</guid><title>Saved article</title><link>https://example.com/saved</link><description>Readable feed text.</description></item></channel></rss>`,
      headers: { "content-type": "application/rss+xml; charset=utf-8" },
    }),
  });
  const f = await piSourceHarness(t);
  f.runtime.appendEntry = () => {
    throw new Error("fixture card renderer failed");
  };
  const notices = [];
  const result = await f.tools
    .find((tool) => tool.name === "current_source_import")
    .execute("card-failure", { url: feedUrl }, undefined, undefined, {
      hasUI: true,
      ui: { notify: (...args) => notices.push(args) },
    });

  assert.equal(result.structuredContent.status, "saved");
  assert.equal(result.structuredContent.count, 1);
  assert.equal(result.structuredContent.references.length, 1);
  assert.match(result.structuredContent.message, /saved.*local card/i);
  assert.match(notices[0][0], /saved.*local card/i);
  assert.equal((await f.library.latest()).items.length, 1);
});

test("session shutdown closes an active reader and prevents a stale result", async (t) => {
  const { requests, lookups } = mockPages(t, {
    lookup: async () => [{ address: PUBLIC_IP, family: 4 }],
    response: () => ({
      body: rss(longBody()),
      headers: { "content-type": "application/rss+xml; charset=utf-8" },
    }),
  });
  const f = await piSourceHarness(t);
  const imported = await f.tools
    .find((tool) => tool.name === "current_source_import")
    .execute("import", { url: feedUrl });
  const entriesBeforeRead = f.entries.length;
  const reference = imported.structuredContent.references[0];
  let screen;
  const context = readerContext({
    onScreen(component) {
      screen = component;
    },
  });
  const pending = definition(f.extension, "current_library_read").execute(
    "cancelled-read",
    reference,
    undefined,
    undefined,
    context,
  );
  for (let attempt = 0; !screen && attempt < 100; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(screen, "reader screen opened");
  for (const handler of f.extension.handlers.get("session_shutdown") ?? [])
    await handler({ type: "session_shutdown" }, context);
  await assert.rejects(pending, /CANCELLED/);
  assert.equal(f.entries.length, entriesBeforeRead, "a cancelled read publishes no stale card");
  assert.equal(requests.length, 1);
  assert.equal(lookups.length, 1);
});

test("local reader strips terminal controls from untrusted article text", async () => {
  let displayed = "";
  const context = readerContext({
    onScreen(component) {
      displayed = component.render(72).join("\n");
      component.handleInput("escape");
    },
  });
  const result = await openLocalReader(
    context,
    {
      title: "Fixture article",
      url: "https://example.com/article",
      text: "\u001b[31mReadable article text\u001b[0m",
    },
    new AbortController().signal,
  );
  assert.equal(result, true);
  assert.match(displayed, /Readable article text/);
  assert.equal(displayed.includes("\u001b"), false);
});
