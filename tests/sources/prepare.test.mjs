import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { test } from "node:test";
import { SQLiteContentLibrary } from "../../src/library/store.ts";
import { selectPreparedReading } from "../../src/reading/discover.ts";
import { prepareSources } from "../../src/sources/prepare.ts";
import { normalizeFeedUrl, sourceIdFor } from "../../src/sources/import.ts";
import { mockPages } from "../helpers/page-harness.mjs";

const feedMime = "application/rss+xml; charset=utf-8";
const etag = '"feed-v1"';

function item({ id, title = id, link = `https://articles.example.test/${id}` }) {
  return `<item><title>${title}</title><guid>${id}</guid><link>${link}</link></item>`;
}

function rss(items) {
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items.join("")}</channel></rss>`;
}

function source(name, url, enabled = true) {
  return { name, url, enabled };
}

function header(options, name) {
  const match = Object.entries(options.headers).find(([key]) => key.toLowerCase() === name);
  return match?.[1];
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-current-feed-prepare-"));
  const library = new SQLiteContentLibrary(root);
  t.after(async () => {
    await library.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, library };
}

function feedPages(t, feeds) {
  return mockPages(t, {
    response: ({ url, options }) => {
      const value = feeds.get(url.href);
      if (!value) return { status: 404, body: "Not found" };
      if (typeof value === "function") return value({ url, options });
      return typeof value === "string"
        ? { body: value, headers: { "content-type": feedMime } }
        : value;
    },
  });
}

test("preparation saves the full normalized feed and a 304 reuses stored item references", async (t) => {
  const f = await setup(t);
  const url = "https://feeds.example.test/current.xml";
  const xml = rss(
    Array.from({ length: 12 }, (_, index) =>
      item({ id: `item-${index + 1}`, title: `Target entry ${index + 1}` }),
    ),
  );
  const { requests } = feedPages(
    t,
    new Map([
      [
        url,
        ({ options }) =>
          header(options, "if-none-match") === etag
            ? { status: 304, body: "", headers: { etag } }
            : { body: xml, headers: { "content-type": feedMime, etag } },
      ],
    ]),
  );
  const now = Date.parse("2026-11-04T00:00:00.000Z");
  const configured = "HTTPS://FEEDS.EXAMPLE.TEST:443/current.xml#configured";

  const result = await prepareSources(
    f.library,
    [
      source("Current", configured),
      source("Disabled", "https://feeds.example.test/disabled.xml", false),
    ],
    undefined,
    now,
  );

  assert.equal(result.enabledSources, 1);
  assert.equal(result.refreshed, 1);
  assert.equal(result.processed, 12);
  assert.equal("nextRefreshAt" in result, false);
  assert.equal(requests.length, 1);
  const normalized = normalizeFeedUrl(configured);
  const sourceId = sourceIdFor(normalized);
  assert.equal(sourceIdFor("https://feeds.example.test/current.xml"), sourceId);
  assert.equal(result.feeds[0].batch.sourceId, sourceId);
  assert.equal(result.feeds[0].batch.items.length, 12);
  assert.equal(result.feeds[0].batch.items[0].metadata.sourceUrl, normalized);
  assert.deepEqual(result.feeds[0].issues, []);

  const selected = selectPreparedReading(result, { terms: ["target"], limit: 1 });
  assert.equal(selected.items[0].sourceName, "Current");
  assert.equal(selected.items[0].item, result.feeds[0].batch.items[0]);
  assert.deepEqual(
    selected.items.map(({ item: saved }) => saved.externalId),
    ["item-1"],
  );

  const unchanged = await prepareSources(
    f.library,
    [source("Current", configured)],
    undefined,
    now + 1_000,
  );
  assert.equal(unchanged.refreshed, 1);
  assert.equal(unchanged.processed, 0);
  assert.equal(unchanged.feeds[0].batch.id, result.feeds[0].batch.id);
  assert.equal(unchanged.feeds[0].batch.items[0].itemId, result.feeds[0].batch.items[0].itemId);
  assert.equal(
    unchanged.feeds[0].batch.items[0].versionId,
    result.feeds[0].batch.items[0].versionId,
  );
  assert.equal(requests.length, 2);
  assert.equal(header(requests[1].options, "if-none-match"), etag);
});

test("failed refresh keeps the last successful snapshot; 304 and empty 200 responses are successful", async (t) => {
  const f = await setup(t);
  const url = "https://feeds.example.test/refresh.xml";
  const firstXml = rss([
    "<item><title>Entry without a usable link</title><guid>no-link</guid></item>",
    item({ id: "previous-success", title: "Target previous" }),
  ]);
  let mode = "initial";
  const { requests } = feedPages(
    t,
    new Map([
      [
        url,
        ({ options }) => {
          if (mode === "failure") {
            return {
              status: 503,
              body: "Service unavailable",
              headers: { "content-type": feedMime },
            };
          }
          if (mode === "unchanged" && header(options, "if-none-match") === etag) {
            return { status: 304, body: "", headers: { etag } };
          }
          if (mode === "empty") {
            return { body: rss([]), headers: { "content-type": feedMime } };
          }
          return { body: firstXml, headers: { "content-type": feedMime, etag } };
        },
      ],
    ]),
  );
  const configured = [source("Refresh", url)];
  const start = Date.parse("2026-11-04T00:00:00.000Z");

  const initial = await prepareSources(f.library, configured, undefined, start);
  const previousSuccessAt = initial.feeds[0].batch.collectedAt;
  assert.deepEqual(
    initial.feeds[0].batch.items.map(({ externalId }) => externalId),
    ["previous-success"],
  );
  assert.match(initial.feeds[0].issues.join(" "), /Entry 1:/);
  assert.equal(initial.processed, 1);
  assert.equal(requests.length, 1);

  mode = "failure";
  const failed = await prepareSources(f.library, configured, undefined, start + 1_000);
  assert.equal(failed.refreshed, 1);
  assert.equal(failed.processed, 0);
  assert.deepEqual(
    failed.feeds[0].batch.items.map(({ externalId }) => externalId),
    ["previous-success"],
  );
  assert.match(failed.feeds[0].issues.join(" "), /503/);
  assert.ok(failed.feeds[0].issues.join(" ").includes(previousSuccessAt));
  assert.equal(requests.length, 2);
  assert.equal(header(requests[1].options, "if-none-match"), etag);

  mode = "unchanged";
  const unchanged = await prepareSources(f.library, configured, undefined, start + 2_000);
  assert.equal(unchanged.refreshed, 1);
  assert.equal(unchanged.processed, 0);
  assert.equal(unchanged.feeds[0].batch.id, initial.feeds[0].batch.id);
  assert.deepEqual(unchanged.feeds[0].issues, [
    "The saved feed snapshot contains one or more entry issues.",
  ]);
  assert.equal(requests.length, 3);

  mode = "empty";
  const emptySuccess = await prepareSources(f.library, configured, undefined, start + 3_000);
  assert.equal(emptySuccess.refreshed, 1);
  assert.equal(emptySuccess.processed, 0);
  assert.deepEqual(emptySuccess.feeds[0].issues, []);
  assert.deepEqual(emptySuccess.feeds[0].batch.items, []);
  assert.deepEqual(selectPreparedReading(emptySuccess, {}).items, []);
  assert.equal(requests.length, 4);

  const stored = await f.library.prepared(sourceIdFor(url));
  assert.equal(
    stored.validators,
    undefined,
    "a 200 response without validators clears the old ETag",
  );
});

test("all entry diagnostics can be stored with valid feed items", async (t) => {
  const f = await setup(t);
  const url = "https://feeds.example.test/many-issues.xml";
  const invalid = Array.from(
    { length: 101 },
    (_, index) => `<item><title>Missing link ${index}</title><guid>invalid-${index}</guid></item>`,
  );
  const xml = rss([...invalid, item({ id: "valid", title: "Still saved" })]);
  feedPages(t, new Map([[url, xml]]));

  const result = await prepareSources(f.library, [source("Many issues", url)]);

  assert.equal(result.feeds[0].issues.length, 101);
  assert.equal(result.processed, 1);
  assert.deepEqual(
    result.feeds[0].batch.items.map(({ externalId }) => externalId),
    ["valid"],
  );
});

test("feed URL normalization rejects invalid schemes and credentials while preserving stable identity", () => {
  const normalized = normalizeFeedUrl("HTTPS://Feeds.Example.test:443/current.xml#configured");
  assert.equal(normalized, "https://feeds.example.test/current.xml");
  assert.equal(
    sourceIdFor(normalizeFeedUrl(normalized)),
    sourceIdFor(normalizeFeedUrl("https://feeds.example.test/current.xml#another")),
  );
  assert.throws(() => normalizeFeedUrl("file:///private/feed.xml"), /HTTP or HTTPS URL/i);
  assert.throws(
    () => normalizeFeedUrl("https://reader:secret@feeds.example.test/feed.xml"),
    /without credentials/i,
  );
});

test("cancellation during feed acquisition does not record a failed attempt", async (t) => {
  const f = await setup(t);
  const url = "https://feeds.example.test/slow.xml";
  const controller = new AbortController();
  const stream = new Readable({ read() {} });
  const { requests } = mockPages(t, {
    response: () => ({ stream, headers: { "content-type": feedMime } }),
  });
  const pending = prepareSources(f.library, [source("Slow", url)], controller.signal);

  for (let attempt = 0; attempt < 200 && !requests[0]?.response; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(requests[0]?.response, "the HTTP response should be open before cancellation");
  controller.abort();

  await assert.rejects(pending, /CANCELLED|cancel/i);
  assert.equal(requests[0].destroyed, true);
  assert.equal(await f.library.prepared(sourceIdFor(url)), undefined);
});

test("an uncertain snapshot write is reported without a second failure write", async (t) => {
  const f = await setup(t);
  const url = "https://feeds.example.test/write-error.xml";
  feedPages(t, new Map([[url, rss([item({ id: "write-error" })])]]));
  const calls = [];
  const library = {
    prepared: (sourceId, signal) => f.library.prepared(sourceId, signal),
    prepare: async (request) => {
      calls.push(request);
      if (request.save) throw new Error("LIBRARY_WRITE_UNCERTAIN");
      return f.library.prepare(request);
    },
  };

  const result = await prepareSources(library, [source("Write error", url)]);

  assert.equal(result.refreshed, 1);
  assert.match(result.feeds[0].issues.join(" "), /LIBRARY_WRITE_UNCERTAIN/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].save);
});
