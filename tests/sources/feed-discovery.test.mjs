import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { discoverFeed } from "../../src/sources/feed-discovery.ts";
import { mockPages } from "../helpers/page-harness.mjs";

const rssMime = "application/rss+xml; charset=utf-8";
const rss = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>Current item</title><guid>item-1</guid><link>https://articles.example.test/one</link></item>
</channel></rss>`;

test("direct feeds parse the downloaded page once and retain the normalized input identity", async (t) => {
  const { requests } = mockPages(t, {
    response: () => ({ body: rss, headers: { "content-type": "text/html; charset=utf-8" } }),
  });

  const result = await discoverFeed(
    "https://feeds.example.test/current.xml#section",
    new AbortController().signal,
  );

  assert.equal(result.url, "https://feeds.example.test/current.xml");
  assert.equal(result.feed.items.length, 1);
  assert.equal(result.feed.items[0].title, "Current item");
  assert.deepEqual(result.feed.issues, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.href, "https://feeds.example.test/current.xml");
});

test("HTML discovery resolves alternate RSS and Atom links against the first valid base", async (t) => {
  const html = `<!doctype html><html><head>
    <base href="javascript:alert(1)"><base href="/feeds/current/">
    <link rel="stylesheet ALTERNATE" type="Application/RSS+XML; charset=UTF-8" href="../rss.xml#latest" title="  Main feed  ">
    <link rel="next alternate" type="Application/Atom+XML" href="atom.xml?edition=2" title="  Atom feed ">
    <link rel="alternate" type="text/html" href="/not-a-feed">
    <link rel="alternate" type="application/rss+xml" href="/feeds/current/../rss.xml#other" title="Ignored duplicate title">
    <link rel="alternate" type="application/atom+xml" href="javascript:alert(2)">
    <link rel="alternate" type="application/atom+xml" href="https://user:secret@feeds.example.test/private.xml">
    <script>document.head.insertAdjacentHTML("beforeend", '<link rel="alternate" type="application/rss+xml" href="/script.xml">')</script>
    <script src="https://tracker.example.test/script.js"></script>
    <img src="http://127.0.0.1/private">
    </head><body>News</body></html>`;
  const { requests } = mockPages(t, {
    response: ({ url }) =>
      url.pathname === "/home"
        ? { status: 302, headers: { location: "/blog/landing/" } }
        : { body: html, headers: { "content-type": "application/xhtml+xml; charset=utf-8" } },
  });

  const result = await discoverFeed("https://site.example.test/home", new AbortController().signal);

  assert.deepEqual(result, {
    candidates: [
      { url: "https://site.example.test/feeds/rss.xml", title: "Main feed" },
      { url: "https://site.example.test/feeds/current/atom.xml?edition=2", title: "Atom feed" },
    ],
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url.href, "https://site.example.test/blog/landing/");
});

test("HTML discovery returns zero or multiple declared candidates without fetching them", async (t) => {
  await t.test("no feed links", async (subtest) => {
    const { requests } = mockPages(subtest, {
      response: () => ({ body: "<html><head><title>Site</title></head></html>" }),
    });

    assert.deepEqual(
      await discoverFeed("https://site.example.test/", new AbortController().signal),
      { candidates: [] },
    );
    assert.equal(requests.length, 1);
  });

  await t.test(
    "unparseable feed markup served as HTML remains a page with no declarations",
    async (subtest) => {
      mockPages(subtest, { response: () => ({ body: "<rss><channel>" }) });
      assert.deepEqual(await discoverFeed("https://site.example.test/"), { candidates: [] });
    },
  );

  await t.test("multiple links", async (subtest) => {
    const { requests } = mockPages(subtest, {
      response: () => ({
        body: `<link rel="alternate" type="application/rss+xml" href="/one.xml">
          <link rel="alternate" type="application/atom+xml" href="/two.xml">`,
      }),
    });

    assert.deepEqual(
      await discoverFeed("https://site.example.test/", new AbortController().signal),
      {
        candidates: [
          { url: "https://site.example.test/one.xml" },
          { url: "https://site.example.test/two.xml" },
        ],
      },
    );
    assert.equal(requests.length, 1);
  });
});

test("relative feed links without a base use the final redirected page URL", async (t) => {
  const { requests } = mockPages(t, {
    response: ({ url }) =>
      url.pathname === "/old"
        ? { status: 302, headers: { location: "/journal/" } }
        : { body: '<link rel="alternate" type="application/rss+xml" href="feed.xml">' },
  });
  assert.deepEqual(await discoverFeed("https://site.example.test/old"), {
    candidates: [{ url: "https://site.example.test/journal/feed.xml" }],
  });
  assert.equal(requests.length, 2);
});

test("partial and malformed direct feeds fail instead of producing discovery candidates", async (t) => {
  const cases = [
    {
      name: "partial feed",
      response: () => ({
        status: 206,
        body: rss,
        headers: { "content-type": rssMime },
      }),
      error: /partial/i,
    },
    {
      name: "partial HTML page with a feed link",
      response: () => ({
        status: 206,
        body: '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      error: /partial/i,
    },
    {
      name: "malformed feed",
      response: () => ({
        body: '<?xml version="1.0"?><rss><channel><item>',
        headers: { "content-type": rssMime },
      }),
      error: /malformed|incomplete|XML|parse/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      mockPages(subtest, { response: scenario.response });
      await assert.rejects(
        discoverFeed("https://feeds.example.test/feed", new AbortController().signal),
        scenario.error,
      );
    });
  }
});

test("HTML discovery reports unsupported encodings and enforces the existing DOM ceiling", async (t) => {
  await t.test("unsupported encoding", async (subtest) => {
    mockPages(subtest, {
      response: () => ({
        body: "<html><head></head></html>",
        headers: { "content-type": "text/html; charset=not-a-real-encoding" },
      }),
    });

    await assert.rejects(
      discoverFeed("https://site.example.test/", new AbortController().signal),
      /UNSUPPORTED_ENCODING/i,
    );
  });

  await t.test("element limit", async (subtest) => {
    mockPages(subtest, {
      response: () => ({
        body: `<html><body>${"<div></div>".repeat(30_001)}</body></html>`,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    });

    await assert.rejects(
      discoverFeed("https://site.example.test/", new AbortController().signal),
      /30,000-element parsing limit/i,
    );
  });
});

test("caller cancellation stops an in-flight discovery request", async (t) => {
  const { requests } = mockPages(t, {
    response: () => ({
      stream: new PassThrough(),
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  });
  const controller = new AbortController();
  const pending = discoverFeed("https://site.example.test/slow", controller.signal);

  await new Promise(setImmediate);
  assert.equal(requests.length, 1);
  controller.abort();

  await assert.rejects(pending, /CANCELLED|cancel/i);
});
