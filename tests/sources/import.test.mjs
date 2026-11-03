import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { test } from "node:test";
import { SQLiteContentLibrary } from "../../src/library/store.ts";
import { importFeed } from "../../src/sources/import.ts";
import { mockPages } from "../helpers/page-harness.mjs";

const feedMime = "application/rss+xml; charset=utf-8";

function item({ id, title = id, link = `https://articles.example.test/${id}`, summary, body }) {
  return `<item><title>${title}</title><guid>${id}</guid><link>${link}</link>${summary === undefined ? "" : `<description>${summary}</description>`}${body === undefined ? "" : `<content:encoded><![CDATA[${body}]]></content:encoded>`}</item>`;
}

function rss(items) {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>${items.join("")}</channel></rss>`;
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-current-feed-import-"));
  const library = new SQLiteContentLibrary(root);
  t.after(async () => {
    await library.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, library };
}

test("normalized feed identity stays stable and a later candidate preserves its saved body", async (t) => {
  const f = await setup(t);
  const sourceUrl = "https://feeds.example.test/rss";
  const finalUrl = "https://cdn.example.test/current.xml";
  let currentFeed = rss([
    item({ id: "article-1", title: "Full article", body: "<p>Original body.</p>" }),
  ]);
  const { requests } = mockPages(t, {
    response: ({ url }) =>
      url.href === sourceUrl
        ? { status: 302, headers: { location: finalUrl } }
        : { body: currentFeed, headers: { "content-type": feedMime } },
  });

  const first = await importFeed(f.library, {
    url: "HTTPS://Feeds.Example.test:443/rss#initial",
    limit: 1,
  });
  const expectedSourceId = `feed-${createHash("sha256").update(`feed\0${sourceUrl}`).digest("hex").slice(0, 40)}`;
  assert.equal(first.sourceId, expectedSourceId);
  assert.equal(first.batch.items[0].sourceId, expectedSourceId);
  assert.equal(first.batch.items[0].text, "Original body.");
  assert.equal(first.batch.items[0].metadata.sourceUrl, sourceUrl);
  assert.equal(first.batch.items[0].metadata.feedUrl, finalUrl);
  assert.equal("sourceModule" in first.batch.items[0].metadata, false);

  currentFeed = rss([
    item({ id: "article-1", title: "Candidate refresh", summary: "A new summary." }),
  ]);
  const refreshed = await importFeed(f.library, {
    url: "https://feeds.example.test/rss#refreshed",
    limit: 1,
  });

  assert.equal(refreshed.sourceId, first.sourceId);
  assert.equal(refreshed.batch.items[0].itemId, first.batch.items[0].itemId);
  assert.equal(refreshed.batch.items[0].text, "Original body.");
  assert.equal(refreshed.batch.items[0].summary, "A new summary.");
  assert.ok(requests.length >= 4);
  assert.ok(requests.every(({ url }) => [sourceUrl, finalUrl].includes(url.href)));
});

test("a long configured URL that fits source provenance imports when the final URL is identical", async (t) => {
  const f = await setup(t);
  const url = `https://feeds.example.test/${"x".repeat(2_100)}.xml`;
  const xml = rss([item({ id: "long-feed-entry" })]);
  mockPages(t, {
    response: () => ({ body: xml, headers: { "content-type": feedMime } }),
  });

  const result = await importFeed(f.library, { url, limit: 1 });

  assert.equal(result.batch.items.length, 1);
  assert.equal(result.batch.items[0].metadata.sourceUrl, url);
  assert.equal("feedUrl" in result.batch.items[0].metadata, false);
});

test("feed issues isolate invalid and duplicate entries with indexed diagnostics", async (t) => {
  const f = await setup(t);
  const xml = rss([
    item({ id: "same", title: "First", body: "<p>Keep this body.</p>" }),
    item({ id: "same", title: "Duplicate", link: "https://articles.example.test/other" }),
    `<item><title>PRIVATE RAW ARTICLE CONTENT</title><guid>missing-link</guid><description>Private summary</description></item>`,
    item({ id: "candidate", summary: "Only the feed summary is present." }),
  ]);
  mockPages(t, {
    response: () => ({ body: xml, headers: { "content-type": feedMime } }),
  });

  const result = await importFeed(f.library, {
    url: "https://feeds.example.test/issues.xml",
    limit: 5,
  });

  assert.deepEqual(
    result.batch.items.map(({ externalId }) => externalId),
    ["same", "candidate"],
  );
  assert.equal(result.batch.items[0].text, "Keep this body.");
  assert.equal(result.batch.items[1].summary, "Only the feed summary is present.");
  assert.equal("text" in result.batch.items[1], false);
  assert.deepEqual(
    result.issues.map(({ index }) => index),
    [1, 2],
  );
  assert.match(result.issues[0].message, /duplicate/i);
  assert.match(result.issues[1].message, /usable HTTP\(S\) article URL/i);
  assert.ok(result.issues.every(({ message }) => !message.includes("PRIVATE RAW ARTICLE CONTENT")));
  assert.deepEqual(result.batch.failures, [{ externalId: "1", code: "SOURCE_ISSUE" }]);
  assert.equal(result.batch.stopReason, "partial");
});

test("omitted import limit defaults to five entries", async (t) => {
  const f = await setup(t);
  const xml = rss(Array.from({ length: 6 }, (_, index) => item({ id: `article-${index}` })));
  const { requests } = mockPages(t, {
    response: () => ({ body: xml, headers: { "content-type": feedMime } }),
  });

  const result = await importFeed(f.library, { url: "https://feeds.example.test/default.xml" });

  assert.equal(result.batch.items.length, 5);
  assert.equal(result.batch.stopReason, "limit");
  assert.deepEqual(result.issues, []);
  assert.equal(requests.length, 1);
});

test("invalid import inputs fail at the import boundary before network access", async (t) => {
  const f = await setup(t);
  const { requests } = mockPages(t);
  const invalidInputs = [
    undefined,
    null,
    [],
    { url: "not a URL" },
    { url: "file:///private/feed.xml" },
    { url: "https://user:secret@feeds.example.test/feed.xml" },
    { url: "https://feeds.example.test/feed.xml", limit: 0 },
    { url: "https://feeds.example.test/feed.xml", limit: 11 },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(importFeed(f.library, input), /Invalid source input/i);
  }
  assert.equal(requests.length, 0);
  assert.equal(await f.library.latest(), undefined);
});

test("configured URL provenance over the library metadata limit is rejected before fetching", async (t) => {
  const f = await setup(t);
  const { requests } = mockPages(t);
  const url = `https://feeds.example.test/${"x".repeat(4_100)}.xml`;

  await assert.rejects(
    importFeed(f.library, { url, limit: 1 }),
    /configured URL provenance exceeds the library metadata limit/i,
  );
  assert.equal(requests.length, 0);
  assert.equal(await f.library.latest(), undefined);
});

test("HTTP fetch failure propagates without saving a batch", async (t) => {
  const f = await setup(t);
  mockPages(t, {
    response: () => ({
      status: 503,
      body: "Service unavailable",
      headers: { "content-type": feedMime },
    }),
  });

  await assert.rejects(
    importFeed(f.library, { url: "https://feeds.example.test/unavailable.xml", limit: 1 }),
    /HTTP_STATUS|503|status/i,
  );
  assert.equal(await f.library.latest(), undefined);
});

test("SQLite save failure propagates instead of returning an import receipt", async (t) => {
  const f = await setup(t);
  const xml = rss([item({ id: "article-1", body: "<p>Body.</p>" })]);
  mockPages(t, {
    response: () => ({ body: xml, headers: { "content-type": feedMime } }),
  });
  await writeFile(join(f.root, "content.sqlite"), "not a SQLite database");

  await assert.rejects(
    importFeed(f.library, { url: "https://feeds.example.test/save-error.xml", limit: 1 }),
    /LIBRARY_STORAGE_ERROR|LIBRARY_WRITE_UNCERTAIN/i,
  );
});

test("cancelling an in-flight HTTP response stops import before SQLite persistence", async (t) => {
  const f = await setup(t);
  const controller = new AbortController();
  const stream = new Readable({ read() {} });
  const { requests } = mockPages(t, {
    response: () => ({ stream, headers: { "content-type": feedMime } }),
  });
  const pending = importFeed(
    f.library,
    { url: "https://feeds.example.test/slow.xml", limit: 1 },
    controller.signal,
  );

  for (let attempt = 0; attempt < 20 && !requests[0]?.response; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(requests[0]?.response, "the HTTP response should be open before cancellation");
  controller.abort();

  await assert.rejects(pending, /CANCELLED|cancel/i);
  assert.equal(requests[0].destroyed, true);
  assert.equal(await f.library.latest(), undefined);
});

test("timeout during an in-flight HTTP response reports TIMEOUT and does not save", async (t) => {
  const f = await setup(t);
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  const stream = new Readable({ read() {} });
  const { requests } = mockPages(t, {
    response: () => ({ stream, headers: { "content-type": feedMime } }),
  });
  const pending = importFeed(f.library, {
    url: "https://feeds.example.test/timeout.xml",
    limit: 1,
  });

  for (let attempt = 0; attempt < 20 && !requests[0]?.response; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(requests[0]?.response, "the HTTP response should be open before timeout");
  deadline.abort(new DOMException("controlled timeout", "TimeoutError"));

  await assert.rejects(pending, (error) => error.code === "TIMEOUT");
  assert.equal(requests[0].destroyed, true);
  assert.equal(await f.library.latest(), undefined);
});

test("library entry failures use original feed positions and explain oversized provenance", async (t) => {
  const f = await setup(t);
  const sourceUrl = "https://feeds.example.test/redirected.xml";
  const finalUrl = `https://cdn.example.test/${"f".repeat(4_100)}.xml`;
  const xml = rss([
    `<item><title>Missing link</title><guid>missing-link</guid></item>`,
    item({ id: "oversized-provenance" }),
  ]);
  mockPages(t, {
    response: ({ url }) =>
      url.href === sourceUrl
        ? { status: 302, headers: { location: finalUrl } }
        : { body: xml, headers: { "content-type": feedMime } },
  });

  const result = await importFeed(f.library, { url: sourceUrl, limit: 5 });

  assert.deepEqual(
    result.issues.map(({ index }) => index),
    [0, 1],
  );
  assert.match(result.issues[0].message, /usable HTTP\(S\) article URL/i);
  assert.match(result.issues[1].message, /metadata.*4,096-character library limit/i);
  assert.equal(result.batch.items.length, 0);
});
