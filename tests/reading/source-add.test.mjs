import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addSource, readSources, updateSources, writeSources } from "../../src/reading/sources.ts";
import { mockPages } from "../helpers/page-harness.mjs";

const feedMime = "application/rss+xml; charset=utf-8";
const defaults = [
  { name: "MIT Research", url: "https://news.mit.edu/rss/research", enabled: true },
  { name: "JSTOR Daily", url: "https://daily.jstor.org/feed", enabled: true },
  { name: "Psyche", url: "https://psyche.co/feed.rss", enabled: true },
];

function rss(...items) {
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items.join("")}</channel></rss>`;
}

function item(id, title = id) {
  return `<item><title>${title}</title><guid>${id}</guid><link>https://articles.example.test/${id}</link></item>`;
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-current-source-add-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function feedPages(t, response) {
  return mockPages(t, { response });
}

test("a new feed is parsed before its normalized enabled source is persisted", async (t) => {
  const root = await temporaryRoot(t);
  const { requests } = feedPages(t, () => ({
    body: rss(item("one", "First article")),
    headers: { "content-type": feedMime },
  }));

  const result = await addSource(root, {
    name: "  Local Lab  ",
    url: "HTTPS://FEEDS.EXAMPLE.TEST:443/lab.xml#section",
  });

  assert.deepEqual(result, {
    source: {
      name: "Local Lab",
      url: "https://feeds.example.test/lab.xml",
      enabled: true,
    },
    added: true,
    issues: [],
  });
  assert.deepEqual(await readSources(root), [...defaults, result.source]);
  assert.equal(requests.length, 1);
});

test("an existing normalized URL returns its current source without fetching or changing it", async (t) => {
  const root = await temporaryRoot(t);
  const current = {
    name: "Existing name",
    url: "https://feeds.example.test/current.xml",
    enabled: false,
  };
  await writeSources(root, [...defaults, current]);
  const before = await readFile(join(root, "sources.json"), "utf8");
  const { requests } = feedPages(t, () => {
    throw new Error("duplicate source should not be fetched");
  });

  const result = await addSource(root, {
    name: "Replacement name",
    url: "HTTPS://FEEDS.EXAMPLE.TEST:443/current.xml#latest",
  });

  assert.deepEqual(result, { source: current, added: false, issues: [] });
  assert.equal(requests.length, 0);
  assert.equal(await readFile(join(root, "sources.json"), "utf8"), before);
});

test("successful feeds return parser issue messages without exposing response content", async (t) => {
  const root = await temporaryRoot(t);
  const privateBody = "secret response text";
  const { requests } = feedPages(t, () => ({
    body: rss(`<item><title>${privateBody}</title></item>`),
    headers: { "content-type": feedMime },
  }));

  const result = await addSource(root, {
    name: "Partial feed",
    url: "https://feeds.example.test/partial.xml",
  });

  assert.equal(result.added, true);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /usable HTTP\(S\) article URL/i);
  assert.ok(result.issues.every((issue) => typeof issue === "string"));
  assert.ok(!JSON.stringify(result).includes(privateBody));
  assert.equal(requests.length, 1);
});

test("a valid empty feed is accepted and saved", async (t) => {
  const root = await temporaryRoot(t);
  feedPages(t, () => ({
    body: `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`,
    headers: { "content-type": "application/atom+xml; charset=utf-8" },
  }));

  const result = await addSource(root, {
    name: "Empty feed",
    url: "https://feeds.example.test/empty.xml",
  });

  assert.equal(result.added, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual((await readSources(root)).at(-1), result.source);
});

test("invalid input fails before network access or configuration changes", async (t) => {
  const root = await temporaryRoot(t);
  const before = await readSources(root);
  const { requests } = feedPages(t, () => {
    throw new Error("invalid source input should not be fetched");
  });

  await assert.rejects(
    addSource(root, { name: "  ", url: "https://feeds.example.test/invalid.xml" }),
    /invalid source list.*name/i,
  );

  assert.equal(requests.length, 0);
  assert.deepEqual(await readSources(root), before);
});

test("HTML, malformed XML, and failed HTTP requests leave sources unchanged", async (t) => {
  for (const scenario of [
    {
      name: "HTML",
      response: () => ({ body: "private error page", headers: { "content-type": "text/html" } }),
      expected: /HTML rather than RSS or Atom/i,
    },
    {
      name: "malformed XML",
      response: () => ({
        body: "<rss><channel>",
        headers: { "content-type": feedMime },
      }),
      expected: /malformed|incomplete/i,
    },
    {
      name: "HTTP failure",
      response: () => ({ status: 503, body: "private server response" }),
      expected: /HTTP 503/i,
    },
  ]) {
    await t.test(scenario.name, async (subtest) => {
      const root = await temporaryRoot(subtest);
      const before = await readSources(root);
      feedPages(subtest, scenario.response);

      await assert.rejects(
        addSource(root, {
          name: "Rejected feed",
          url: "https://feeds.example.test/rejected.xml",
        }),
        scenario.expected,
      );

      assert.deepEqual(await readSources(root), before);
    });
  }
});

test("cancellation during feed retrieval leaves sources unchanged", async (t) => {
  const root = await temporaryRoot(t);
  const before = await readSources(root);
  const controller = new AbortController();
  feedPages(t, () => {
    controller.abort();
    return {
      body: rss(item("one")),
      headers: { "content-type": feedMime },
    };
  });

  await assert.rejects(
    addSource(
      root,
      { name: "Cancelled feed", url: "https://feeds.example.test/cancelled.xml" },
      controller.signal,
    ),
    /^Error: CANCELLED$/,
  );

  assert.deepEqual(await readSources(root), before);
});

test("a source toggle made while fetching is preserved when the feed is added", async (t) => {
  const root = await temporaryRoot(t);
  let finishResponse;
  let notifyFetchStarted;
  const responseGate = new Promise((resolve) => {
    finishResponse = resolve;
  });
  const fetchStarted = new Promise((resolve) => {
    notifyFetchStarted = resolve;
  });
  const { requests } = feedPages(t, async () => {
    notifyFetchStarted();
    await responseGate;
    return { body: rss(item("one")), headers: { "content-type": feedMime } };
  });

  const pendingAdd = addSource(root, {
    name: "Delayed feed",
    url: "https://feeds.example.test/delayed.xml",
  });
  await fetchStarted;
  assert.equal(requests.length, 1);
  await updateSources(root, (sources) =>
    sources.map((source) =>
      source.name === "MIT Research" ? { ...source, enabled: false } : source,
    ),
  );
  finishResponse();

  const result = await pendingAdd;
  const saved = await readSources(root);
  assert.equal(result.added, true);
  assert.equal(saved.find((source) => source.name === "MIT Research")?.enabled, false);
  assert.equal(
    saved.some((source) => source.url === result.source.url),
    true,
  );
});

test("concurrent additions of the same URL persist once and report the committed source", async (t) => {
  const root = await temporaryRoot(t);
  feedPages(t, ({ url }) => ({
    body: rss(item(url.pathname)),
    headers: { "content-type": feedMime },
  }));

  const results = await Promise.all([
    addSource(root, {
      name: "First name",
      url: "https://feeds.example.test/same.xml",
    }),
    addSource(root, {
      name: "Second name",
      url: "HTTPS://FEEDS.EXAMPLE.TEST:443/same.xml#part",
    }),
  ]);

  assert.deepEqual(results.map((result) => result.added).sort(), [false, true]);
  assert.equal(results[0].source.name, results[1].source.name);
  assert.equal(
    (await readSources(root)).filter(
      (source) => source.url === "https://feeds.example.test/same.xml",
    ).length,
    1,
  );
});

test("serialized source updates do not lose concurrent mutations and recover after failure", async (t) => {
  const root = await temporaryRoot(t);

  await Promise.all([
    updateSources(root, (sources) => [
      ...sources,
      { name: "First", url: "https://feeds.example.test/first.xml", enabled: true },
    ]),
    updateSources(root, (sources) => [
      ...sources,
      { name: "Second", url: "https://feeds.example.test/second.xml", enabled: true },
    ]),
  ]);
  assert.deepEqual(
    (await readSources(root))
      .slice(-2)
      .map((source) => source.name)
      .sort(),
    ["First", "Second"],
  );

  await assert.rejects(
    updateSources(root, () => {
      throw new Error("synthetic updater failure");
    }),
    /synthetic updater failure/,
  );
  await updateSources(root, (sources) => sources.filter((source) => source.name !== "First"));
  assert.equal(
    (await readSources(root)).some((source) => source.name === "First"),
    false,
  );
});
