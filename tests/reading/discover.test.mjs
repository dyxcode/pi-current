import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { SQLiteContentLibrary } from "../../src/library/store.ts";
import { discoverReading } from "../../src/reading/discover.ts";
import { mockPages } from "../helpers/page-harness.mjs";

const feedMime = "application/rss+xml; charset=utf-8";

function item({
  id,
  title = id,
  link = `https://articles.example.test/${id}`,
  summary,
  body,
  publishedAt,
}) {
  return `<item><title>${title}</title><guid>${id}</guid><link>${link}</link>${summary === undefined ? "" : `<description>${summary}</description>`}${body === undefined ? "" : `<content:encoded><![CDATA[${body}]]></content:encoded>`}${publishedAt === undefined ? "" : `<pubDate>${publishedAt}</pubDate>`}</item>`;
}

function rss(items) {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>${items.join("")}</channel></rss>`;
}

function source(name, url, enabled = true) {
  return { name, url, enabled };
}

function sourceIdFor(url) {
  return `feed-${createHash("sha256").update(`feed\0${url}`).digest("hex").slice(0, 40)}`;
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-current-reading-discover-"));
  const library = new SQLiteContentLibrary(root);
  t.after(async () => {
    await library.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, library };
}

function feedPages(t, feeds) {
  return mockPages(t, {
    response: ({ url }) => {
      const value = feeds.get(url.href);
      if (!value) return { status: 404, body: "Not found" };
      return typeof value === "string"
        ? { body: value, headers: { "content-type": feedMime } }
        : value;
    },
  });
}

test("a matching candidate at position 20 can win when the result limit is one", async (t) => {
  const f = await setup(t);
  const url = "https://feeds.example.test/late.xml";
  const xml = rss([
    ...Array.from({ length: 19 }, (_, index) => item({ id: `unmatched-${index + 1}` })),
    item({ id: "late-match", title: "Target phrase arrives late" }),
  ]);
  const { requests } = feedPages(t, new Map([[url, xml]]));

  const result = await discoverReading(f.library, [source("Late feed", url)], {
    terms: ["target phrase"],
    limit: 1,
  });

  assert.deepEqual(
    result.items.map(({ item: saved }) => saved.externalId),
    ["late-match"],
  );
  assert.equal(result.items[0].sourceName, "Late feed");
  assert.equal(requests.length, 1);
});

test("mixed discovery orders by date within feeds and selects sources round-robin", async (t) => {
  const f = await setup(t);
  const firstUrl = "https://feeds.example.test/first.xml";
  const secondUrl = "https://feeds.example.test/second.xml";
  const feeds = new Map([
    [
      firstUrl,
      rss([
        item({ id: "first-missing-a" }),
        item({ id: "first-new", publishedAt: "Wed, 03 Jan 2024 00:00:00 GMT" }),
        item({ id: "first-missing-b" }),
      ]),
    ],
    [
      secondUrl,
      rss([
        item({ id: "second-old", publishedAt: "Tue, 02 Jan 2024 00:00:00 GMT" }),
        item({ id: "second-new", publishedAt: "Thu, 04 Jan 2024 00:00:00 GMT" }),
      ]),
    ],
  ]);
  feedPages(t, feeds);

  const result = await discoverReading(
    f.library,
    [source("First", firstUrl), source("Second", secondUrl)],
    {},
  );

  assert.deepEqual(
    result.items.map(({ item: saved, sourceName }) => [sourceName, saved.externalId]),
    [
      ["First", "first-new"],
      ["Second", "second-new"],
      ["First", "first-missing-a"],
      ["Second", "second-old"],
      ["First", "first-missing-b"],
    ],
  );
});

test("English and CJK phrases match title and summary only", async (t) => {
  const f = await setup(t);
  const url = "https://feeds.example.test/languages.xml";
  feedPages(
    t,
    new Map([
      [
        url,
        rss([
          item({ id: "english", title: "RETRIEVAL augmented systems" }),
          item({ id: "chinese", summary: "基于用户行为的推荐系统" }),
          item({
            id: "body-only",
            title: "Unrelated",
            summary: "Also unrelated",
            body: "privacy appears only in article text",
            link: "https://articles.example.test/body-only",
          }),
        ]),
      ],
    ]),
  );

  const result = await discoverReading(f.library, [source("Language feed", url)], {
    terms: ["RETRIEVAL augmented", "推荐系统", "privacy"],
    limit: 5,
  });

  assert.deepEqual(
    result.items.map(({ item: saved, matchedTerms }) => [saved.externalId, matchedTerms]),
    [
      ["english", ["RETRIEVAL augmented"]],
      ["chinese", ["推荐系统"]],
    ],
  );
});

test("article URLs deduplicate without dropping queries and keep the winning feed identity", async (t) => {
  const f = await setup(t);
  const firstUrl = "https://feeds.example.test/first.xml";
  const secondUrl = "https://feeds.example.test/second.xml";
  const articleUrl = "https://articles.example.test/shared?edition=2";
  feedPages(
    t,
    new Map([
      [
        firstUrl,
        rss([
          item({ id: "first-copy", title: "Graph neural article", link: `${articleUrl}#first` }),
        ]),
      ],
      [
        secondUrl,
        rss([
          item({
            id: "second-copy",
            title: "Graph",
            summary: "Graph neural article",
            link: `${articleUrl}#second`,
          }),
        ]),
      ],
    ]),
  );

  const result = await discoverReading(
    f.library,
    [source("First", firstUrl), source("Second", secondUrl)],
    { terms: ["graph neural"], limit: 5 },
  );

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].sourceName, "First");
  assert.equal(result.items[0].item.url, articleUrl);
  assert.equal(result.items[0].item.sourceId, sourceIdFor(firstUrl));
});

test("zero title or summary matches are not saved", async (t) => {
  const f = await setup(t);
  const url = "https://feeds.example.test/no-match.xml";
  feedPages(
    t,
    new Map([[url, rss([item({ id: "body-only", title: "Other", summary: "Still other" })])]]),
  );

  const result = await discoverReading(f.library, [source("No match", url)], {
    terms: ["not present"],
    limit: 5,
  });

  assert.deepEqual(result.items, []);
  assert.equal(await f.library.latest(sourceIdFor(url)), undefined);
});

test("only selected items are stored and normalized feed identity remains stable", async (t) => {
  const f = await setup(t);
  const url = "https://feeds.example.test/selected.xml";
  const xml = rss([
    item({ id: "top", title: "Target top" }),
    item({ id: "also-match", title: "Target secondary" }),
    item({ id: "not-selected", title: "Unrelated" }),
  ]);
  feedPages(t, new Map([[url, xml]]));

  const first = await discoverReading(
    f.library,
    [source("Selected", "HTTPS://Feeds.Example.test:443/selected.xml#configured")],
    { terms: ["target"], limit: 1 },
  );
  const stored = await f.library.latest(sourceIdFor(url));
  const second = await discoverReading(f.library, [source("Selected", `${url}#again`)], {
    terms: ["target"],
    limit: 1,
  });

  assert.deepEqual(
    first.items.map(({ item: saved }) => saved.externalId),
    ["top"],
  );
  assert.deepEqual(
    stored?.items.map(({ externalId }) => externalId),
    ["top"],
  );
  assert.equal(stored?.items[0]?.metadata?.sourceUrl, url);
  assert.equal(second.items[0]?.item.sourceId, first.items[0]?.item.sourceId);
  assert.equal(second.items[0]?.item.itemId, first.items[0]?.item.itemId);
});

test("disabled sources are excluded from requests and enabled-source count", async (t) => {
  const f = await setup(t);
  const enabledUrl = "https://feeds.example.test/enabled.xml";
  const disabledUrl = "https://feeds.example.test/disabled.xml";
  const { requests } = feedPages(
    t,
    new Map([[enabledUrl, rss([item({ id: "enabled-item", title: "Target" })])]]),
  );

  const result = await discoverReading(
    f.library,
    [source("Disabled", disabledUrl, false), source("Enabled", enabledUrl)],
    { terms: ["target"], limit: 1 },
  );

  assert.equal(result.enabledSources, 1);
  assert.deepEqual(
    requests.map(({ url }) => url.href),
    [enabledUrl],
  );
  assert.equal(result.items[0]?.sourceName, "Enabled");
});

test("feed and save failures are source-labeled while acknowledged saves remain useful", async (t) => {
  const f = await setup(t);
  const fetchFailureUrl = "https://feeds.example.test/fetch-failure.xml";
  const parseFailureUrl = "https://feeds.example.test/parse-failure.xml";
  const saveFailureUrl = "https://feeds.example.test/save-failure.xml";
  const successUrl = "https://feeds.example.test/success.xml";
  const feeds = new Map([
    [
      fetchFailureUrl,
      { status: 503, body: "Service unavailable", headers: { "content-type": feedMime } },
    ],
    [
      parseFailureUrl,
      { body: "<html>Not a feed</html>", headers: { "content-type": "text/html; charset=utf-8" } },
    ],
    [saveFailureUrl, rss([item({ id: "save-failed", title: "Target" })])],
    [successUrl, rss([item({ id: "saved", title: "Target" })])],
  ]);
  feedPages(t, feeds);
  const failedSourceId = sourceIdFor(saveFailureUrl);
  const library = {
    save: async (request, signal) => {
      if (signal?.aborted) throw new Error("LIBRARY_CANCELLED");
      if (request.batch.sourceId === failedSourceId) throw new Error("synthetic save failure");
      return f.library.save(request, signal);
    },
  };

  const result = await discoverReading(
    library,
    [
      source("Fetch failure", fetchFailureUrl),
      source("Parse failure", parseFailureUrl),
      source("Save failure", saveFailureUrl),
      source("Success", successUrl),
    ],
    { terms: ["target"], limit: 4 },
  );

  assert.deepEqual(
    result.items.map(({ sourceName, item: saved }) => [sourceName, saved.externalId]),
    [["Success", "saved"]],
  );
  assert.deepEqual(
    result.issues.map(({ source }) => source),
    ["Fetch failure", "Parse failure", "Save failure"],
  );
  assert.equal((await f.library.latest(sourceIdFor(successUrl)))?.items[0]?.externalId, "saved");
});

test("caller cancellation aborts an in-flight feed request without saving", async (t) => {
  const f = await setup(t);
  const controller = new AbortController();
  const stream = new Readable({ read() {} });
  const { requests } = mockPages(t, {
    response: () => ({ stream, headers: { "content-type": feedMime } }),
  });
  const url = "https://feeds.example.test/slow.xml";
  const pending = discoverReading(
    f.library,
    [source("Slow", url)],
    {
      terms: ["target"],
      limit: 1,
    },
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

test("same-name source failures identify the source's position in the /source menu", async (t) => {
  const f = await setup(t);
  const { requests } = feedPages(t, new Map());
  const result = await discoverReading(
    f.library,
    [
      source("Shared", "https://feeds.example.test/first.xml"),
      source("Disabled", "https://feeds.example.test/disabled.xml", false),
      source("Shared", "https://feeds.example.test/third.xml"),
    ],
    {},
  );
  assert.deepEqual(
    result.issues.map(({ source }) => source),
    ["1. Shared", "3. Shared"],
  );
  assert.equal(requests.length, 2);
});
