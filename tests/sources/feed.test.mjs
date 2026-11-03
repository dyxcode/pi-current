import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { feedModule } from "../../src/sources/feed.ts";
import { mockPages, PUBLIC_IP } from "../helpers/page-harness.mjs";

const atomMime = "application/atom+xml; charset=utf-8";
const rssMime = "application/rss+xml; charset=utf-8";

test("RSS 2 imports explicit content, keeps its summary, resolves xml:base, and honors the limit", async (t) => {
  const feed = `<?xml version="1.0"?>
    <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xml:base="/root/">
      <channel xml:base="entries/">
        <item xml:base="week1/">
          <title>Field report</title>
          <guid>urn:report:one</guid>
          <link>article.html#top</link>
          <author>A. Reader</author>
          <pubDate>Tue, 03 Nov 2026 08:00:00 GMT</pubDate>
          <description><![CDATA[<p>Short summary.</p><ul><li>Signal</li></ul>]]></description>
          <content:encoded><![CDATA[<p>Full <strong>story</strong>.</p><ul><li>First point</li><li>Second point</li></ul>]]></content:encoded>
        </item>
        <item><title>Second</title><guid>urn:report:two</guid><link>/second</link><description>Second story</description></item>
      </channel>
    </rss>`;
  const { requests, lookups } = mockPages(t, {
    response: ({ url }) =>
      url.pathname === "/news/feed.xml"
        ? { status: 302, headers: { location: "/news/current.xml" } }
        : { body: feed, headers: { "content-type": rssMime } },
  });

  const result = await feedModule.fetch(
    { url: "https://feeds.example.test/news/feed.xml", limit: 1 },
    { signal: new AbortController().signal },
  );

  assert.equal(result.items.length, 1);
  assert.deepEqual(result.issues, []);
  const [entry] = result.items;
  assert.equal(entry.externalId, "urn:report:one");
  assert.equal(entry.url, "https://feeds.example.test/root/entries/week1/article.html");
  assert.equal(entry.title, "Field report");
  assert.equal(entry.author, "A. Reader");
  assert.equal(entry.summary, "Short summary.\n- Signal");
  assert.equal(entry.text, "Full story.\n- First point\n- Second point");
  assert.equal(entry.observedPosition, 1);
  assert.equal(entry.metadata.feedUrl, "https://feeds.example.test/news/current.xml");
  assert.equal(entry.metadata.publishedAt, "2026-11-03T08:00:00.000Z");
  assert.ok(Number.isFinite(Date.parse(entry.retrievedAt)));
  assert.equal(entry.discoveredAt, entry.retrievedAt);
  assert.equal(entry.sourceCompleteness, "unknown");
  assert.equal(entry.truncated, false);
  assert.equal("sourceId" in entry, false);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ options }) => /application\/rss\+xml/.test(options.headers.accept)));
  assert.deepEqual(
    requests.map(({ addresses }) => addresses),
    [[{ address: PUBLIC_IP, family: 4 }], [{ address: PUBLIC_IP, family: 4 }]],
  );
  assert.equal(lookups.length, 2);
});

test("RSS description without content:encoded remains a summary-only candidate", async (t) => {
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel><item>
    <title>Candidate</title><guid>candidate-1</guid><link>https://articles.example.test/one</link>
    <description><![CDATA[<p>Overview.</p><ol><li>One</li><li>Two</li></ol>]]></description>
  </item></channel></rss>`;
  mockPages(t, {
    response: () => ({ body: feed, headers: { "content-type": rssMime } }),
  });

  const result = await feedModule.fetch(
    { url: "https://feeds.example.test/rss", limit: 5 },
    { signal: new AbortController().signal },
  );

  assert.equal(result.items.length, 1);
  const [entry] = result.items;
  assert.equal(entry.summary, "Overview.\n- One\n- Two");
  assert.equal(entry.observedPosition, 1);
  assert.equal(entry.metadata.feedUrl, "https://feeds.example.test/rss");
  assert.equal("text" in entry, false);
  assert.ok(Number.isFinite(Date.parse(entry.discoveredAt)));
  assert.equal("retrievedAt" in entry, false);
});

test("Atom inline XHTML is preserved, summaries stay separate, and src content is not fetched", async (t) => {
  const longId = `urn:atom:${"x".repeat(300)}`;
  const feed = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xml:base="../">
      <entry xml:base="items/">
        <id>${longId}</id><title>Atom entry</title>
        <link rel="alternate" type="text/html" href="story.html#part" />
        <published>2026-11-03T10:11:12+10:00</published>
        <author><name>Feed Author</name></author>
        <summary type="html">&lt;p&gt;Separate &lt;em&gt;summary&lt;/em&gt;.&lt;/p&gt;</summary>
        <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Inline <strong>body</strong>.</p><ul><li>First</li><li>Second</li></ul></div></content>
      </entry>
      <entry xml:base="items/">
        <id>urn:atom:remote</id><title>Remote body</title>
        <link href="remote.html" />
        <summary>Only the inline summary is available.</summary>
        <content type="html" src="https://payload.example.test/body.html" />
      </entry>
      <entry xml:base="items/">
        <id>urn:atom:image</id><title>Image content</title><link href="image.html" />
        <summary>Image descriptions stay summaries.</summary><content type="image/png">cGl4ZWw=</content>
      </entry>
    </feed>`;
  const { requests } = mockPages(t, {
    response: () => ({ body: feed, headers: { "content-type": atomMime } }),
  });

  const result = await feedModule.fetch(
    { url: "https://feeds.example.test/atom/index.xml", limit: 5 },
    { signal: new AbortController().signal },
  );

  assert.equal(result.items.length, 3);
  const [entry, remote, image] = result.items;
  assert.equal(entry.externalId, `sha256:${createHash("sha256").update(longId).digest("hex")}`);
  assert.ok(entry.externalId.length <= 256);
  assert.equal(entry.url, "https://feeds.example.test/items/story.html");
  assert.equal(entry.text, "Inline body.\n- First\n- Second");
  assert.equal(entry.summary, "Separate summary.");
  assert.equal(entry.author, "Feed Author");
  assert.equal(entry.metadata.publishedAt, "2026-11-03T00:11:12.000Z");
  assert.equal("text" in remote, false);
  assert.equal(remote.summary, "Only the inline summary is available.");
  assert.equal("text" in image, false);
  assert.equal(image.summary, "Image descriptions stay summaries.");
  assert.deepEqual(
    result.items.map(({ observedPosition }) => observedPosition),
    [1, 2, 3],
  );
  assert.deepEqual(result.issues, [
    { index: 2, message: "The Atom content type is unsupported and was not stored as text." },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.href, "https://feeds.example.test/atom/index.xml");
  assert.match(requests[0].options.headers.accept, /application\/atom\+xml/);
});

test("entries without usable article URLs and duplicate identities or URLs are reported and skipped", async (t) => {
  const feed = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>No link</title><guid>no-link</guid><description>Summary</description></item>
    <item><title>Non-permalink GUID</title><guid isPermaLink="false">https://articles.example.test/id-only</guid></item>
    <item><title>GUID permalink</title><guid>https://articles.example.test/from-guid</guid></item>
    <item><title>First</title><guid>same-id</guid><link>https://articles.example.test/first</link></item>
    <item><title>Duplicate ID</title><guid>same-id</guid><link>https://articles.example.test/other</link></item>
    <item><title>Distinct ID, same URL</title><guid>other-id</guid><link>https://articles.example.test/first#section</link></item>
    <item><title>URL fallback</title><link>https://articles.example.test/fallback#top</link></item>
    <item><title>Duplicate URL fallback</title><link>https://articles.example.test/fallback#other</link></item>
    <item><title>Unsafe scheme</title><guid>unsafe</guid><link>javascript:alert(1)</link></item>
  </channel></rss>`;
  mockPages(t, {
    response: () => ({ body: feed, headers: { "content-type": rssMime } }),
  });

  const result = await feedModule.fetch(
    { url: "https://feeds.example.test/rss", limit: 10 },
    { signal: new AbortController().signal },
  );

  assert.deepEqual(
    result.items.map(({ externalId }) => externalId),
    [
      "https://articles.example.test/from-guid",
      "same-id",
      "other-id",
      "https://articles.example.test/fallback",
    ],
  );
  assert.deepEqual(
    result.issues.map(({ index }) => index),
    [0, 1, 4, 7, 8],
  );
  assert.deepEqual(
    result.items.map(({ observedPosition }) => observedPosition),
    [3, 4, 6, 7],
  );
  assert.match(result.issues[0].message, /HTTP(S)|article URL/i);
  assert.match(result.issues[1].message, /HTTP(S)|article URL/i);
  assert.match(result.issues[2].message, /duplicate/i);
  assert.match(result.issues[3].message, /duplicate/i);
  assert.match(result.issues[4].message, /HTTP(S)|article URL/i);
});

test("valid empty feeds return no entries or issues; RSS without a channel is malformed", async (t) => {
  await t.test("empty Atom", async (subtest) => {
    mockPages(subtest, {
      response: () => ({
        body: `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`,
        headers: { "content-type": atomMime },
      }),
    });
    assert.deepEqual(
      await feedModule.fetch(
        { url: "https://feeds.example.test/atom", limit: 1 },
        { signal: new AbortController().signal },
      ),
      { items: [], issues: [] },
    );
  });

  await t.test("RSS missing channel", async (subtest) => {
    mockPages(subtest, {
      response: () => ({
        body: `<?xml version="1.0"?><rss version="2.0"></rss>`,
        headers: { "content-type": rssMime },
      }),
    });
    await assert.rejects(
      feedModule.fetch(
        { url: "https://feeds.example.test/rss", limit: 1 },
        { signal: new AbortController().signal },
      ),
      /missing its channel/i,
    );
  });
});

test("invalid and oversized inline bodies are reported without clipping", async (t) => {
  const tooLarge = "x".repeat(1024 * 1024 + 1);
  const feed = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
    <item><title>Too large</title><guid>oversized</guid><link>https://articles.example.test/large</link>
      <content:encoded><![CDATA[${tooLarge}]]></content:encoded>
    </item>
  </channel></rss>`;
  mockPages(t, {
    response: () => ({ body: feed, headers: { "content-type": rssMime } }),
  });

  const result = await feedModule.fetch(
    { url: "https://feeds.example.test/rss", limit: 3 },
    { signal: new AbortController().signal },
  );

  assert.deepEqual(result.items, []);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0].message, /exceeds.*1 MiB|too large/i);
});

test("oversized inline HTML structure is bounded and reported per entry", async (t) => {
  const tooManyElements = "<span>x</span>".repeat(30_001);
  const feed = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
    <item><title>Dense body</title><guid>dense</guid><link>https://articles.example.test/dense</link>
      <content:encoded><![CDATA[${tooManyElements}]]></content:encoded>
    </item>
    <item><title>Normal body</title><guid>normal</guid><link>https://articles.example.test/normal</link>
      <content:encoded><![CDATA[<p>Readable body.</p>]]></content:encoded>
    </item>
  </channel></rss>`;
  mockPages(t, {
    response: () => ({ body: feed, headers: { "content-type": rssMime } }),
  });

  const result = await feedModule.fetch(
    { url: "https://feeds.example.test/rss", limit: 3 },
    { signal: new AbortController().signal },
  );

  assert.deepEqual(
    result.items.map(({ externalId }) => externalId),
    ["normal"],
  );
  assert.deepEqual(
    result.issues.map(({ index }) => index),
    [0],
  );
  assert.match(result.issues[0].message, /30,000-element parsing limit/i);
});

test("partial, malformed, and HTML error responses are rejected clearly", async (t) => {
  const cases = [
    {
      name: "partial response",
      body: "<rss><channel></channel></rss>",
      status: 206,
      contentType: rssMime,
      error: /partial/i,
    },
    {
      name: "truncated XML",
      body: '<?xml version="1.0"?><rss><channel><item>',
      status: 200,
      contentType: rssMime,
      error: /malformed|incomplete|parse|well-formed|XML/i,
    },
    {
      name: "HTML error page",
      body: "<!DOCTYPE html><html><head><title>Not found</title></head><body>Missing</body></html>",
      status: 200,
      contentType: "text/html; charset=utf-8",
      error: /RSS|Atom|HTML|error page/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      mockPages(subtest, {
        response: () => ({
          body: scenario.body,
          status: scenario.status,
          headers: { "content-type": scenario.contentType },
        }),
      });
      await assert.rejects(
        feedModule.fetch(
          { url: "https://feeds.example.test/rss", limit: 1 },
          { signal: new AbortController().signal },
        ),
        scenario.error,
      );
    });
  }
});

test("feed retrieval rejects cancellation before opening a socket", async (t) => {
  const { requests } = mockPages(t);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    feedModule.fetch(
      { url: "https://feeds.example.test/rss", limit: 1 },
      { signal: controller.signal },
    ),
    /CANCELLED|cancel/i,
  );
  assert.equal(requests.length, 0);
});

test("Atom text-construct titles are readable and entries inherit the feed author", async (t) => {
  mockPages(t, {
    response: () => ({
      headers: { "content-type": atomMime },
      body: `<feed xmlns="http://www.w3.org/2005/Atom">
        <author><name>Feed Editor</name></author>
        <entry><id>urn:entry:inherited</id><title type="html">&lt;b&gt;A readable title&lt;/b&gt;</title>
          <link href="https://example.org/article"/><content>Entry text</content>
        </entry>
      </feed>`,
    }),
  });
  const result = await feedModule.fetch(
    { url: "https://example.org/feed", limit: 1 },
    { signal: new AbortController().signal },
  );
  assert.equal(result.items[0].title, "A readable title");
  assert.equal(result.items[0].author, "Feed Editor");
});
