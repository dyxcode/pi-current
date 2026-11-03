import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { SQLiteContentLibrary } from "../../src/library/store.ts";
import { importSource } from "../../src/sources/import.ts";

const retrievedAt = "2026-11-03T00:00:00.000Z";

function body(externalId = "article-1", overrides = {}) {
  return {
    externalId,
    url: `https://example.com/${externalId}`,
    title: `Title ${externalId}`,
    text: `Full body ${externalId}`,
    retrievedAt,
    sourceCompleteness: "unknown",
    truncated: false,
    ...overrides,
  };
}

function candidate(externalId = "article-1", overrides = {}) {
  return {
    externalId,
    url: `https://example.com/${externalId}`,
    title: `Title ${externalId}`,
    discoveredAt: retrievedAt,
    ...overrides,
  };
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-current-import-"));
  const library = new SQLiteContentLibrary(root);
  t.after(async () => {
    await library.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, library };
}

test("a normalized feed URL has a stable source identity and candidate refreshes preserve its saved body", async (t) => {
  const f = await setup(t);
  let entry = body("article-1", {
    sourceId: "spoofed-source",
    metadata: {
      publishedAt: "2026-11-02T00:00:00.000Z",
      sourceUrl: "https://spoofed.example/feed",
      sourceModule: "spoofed",
    },
  });
  const module = {
    id: "rss",
    name: "RSS",
    async fetch(input) {
      assert.equal(input.url, "https://example.com/feed");
      return { items: [entry], issues: [] };
    },
  };

  const first = await importSource(module, f.library, {
    url: "HTTPS://Example.com:443/feed#initial",
    limit: 1,
  });
  assert.match(first.sourceId, /^feed-[a-f0-9]{40}$/);
  assert.equal(first.batch.items[0].sourceId, first.sourceId);
  assert.equal(first.batch.items[0].text, "Full body article-1");

  entry = candidate("article-1", {
    metadata: {
      publishedAt: "2026-11-02T00:00:00.000Z",
      sourceUrl: "https://spoofed.example/feed",
      sourceModule: "spoofed",
    },
  });
  const refreshed = await importSource(module, f.library, {
    url: "https://example.com/feed#refreshed",
    limit: 1,
  });
  assert.equal(refreshed.sourceId, first.sourceId);
  assert.equal(refreshed.batch.items[0].itemId, first.batch.items[0].itemId);
  assert.equal(refreshed.batch.items[0].versionId, first.batch.items[0].versionId);
  assert.equal(refreshed.batch.items[0].text, "Full body article-1");
  await f.library.close();
  const reopened = new SQLiteContentLibrary(f.root);
  const saved = await reopened.read({ itemId: first.batch.items[0].itemId });
  assert.equal(saved.text, "Full body article-1");
  assert.deepEqual(saved.metadata, {
    publishedAt: "2026-11-02T00:00:00.000Z",
    sourceUrl: "https://example.com/feed",
    sourceModule: "rss",
  });
  await reopened.close();
});

test("separate feed URLs keep matching external IDs as separate library items", async (t) => {
  const f = await setup(t);
  const module = {
    id: "rss",
    name: "RSS",
    async fetch({ url }) {
      return { items: [candidate("same-id", { url: `${url}/article` })], issues: [] };
    },
  };
  const first = await importSource(module, f.library, {
    url: "https://one.example/feed",
    limit: 1,
  });
  const second = await importSource(module, f.library, {
    url: "https://two.example/feed",
    limit: 1,
  });
  const third = await importSource({ ...module, id: "atom" }, f.library, {
    url: "https://one.example/feed",
    limit: 1,
  });

  assert.notEqual(first.sourceId, second.sourceId);
  assert.notEqual(first.sourceId, third.sourceId);
  assert.equal(first.batch.items[0].externalId, second.batch.items[0].externalId);
  assert.notEqual(first.batch.items[0].itemId, second.batch.items[0].itemId);
  assert.equal((await f.library.latest(first.sourceId)).items.length, 1);
  assert.equal((await f.library.latest(second.sourceId)).items.length, 1);
});

test("invalid and duplicate entries are skipped, indexed, and persisted as one failure", async (t) => {
  const f = await setup(t);
  const module = {
    id: "rss",
    name: "RSS",
    async fetch() {
      return {
        items: [body("same"), body("same"), candidate("bad", { title: 42 }), candidate("later")],
        issues: [{ index: 0, message: "Feed metadata warning" }],
      };
    },
  };
  const result = await importSource(module, f.library, {
    url: "https://example.com/feed",
    limit: 4,
  });

  assert.deepEqual(
    result.batch.items.map((item) => item.externalId),
    ["same", "later"],
  );
  assert.deepEqual(result.issues, [
    { index: 0, message: "Feed metadata warning" },
    { index: 1, message: "Duplicate external ID was skipped." },
    { index: 2, message: "Invalid source entry was skipped." },
  ]);
  assert.deepEqual(result.batch.failures, [{ externalId: "0", code: "SOURCE_ISSUE" }]);
  assert.equal(result.batch.stopReason, "partial");
});

test("entries beyond the requested limit are omitted and reported", async (t) => {
  const f = await setup(t);
  const module = {
    id: "rss",
    name: "RSS",
    async fetch() {
      return { items: [candidate("one"), candidate("two"), candidate("three")], issues: [] };
    },
  };
  const result = await importSource(module, f.library, {
    url: "https://example.com/feed",
    limit: 2,
  });

  assert.deepEqual(
    result.batch.items.map((item) => item.externalId),
    ["one", "two"],
  );
  assert.deepEqual(result.issues, [
    {
      index: 2,
      message: "Source returned more items than the requested limit; extra entries were skipped.",
    },
  ]);
  assert.equal(result.batch.stopReason, "limit");
  assert.deepEqual(result.batch.failures, [{ externalId: "2", code: "SOURCE_ISSUE" }]);
});

test("a fetch failure propagates and does not save an empty batch", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    importSource(
      {
        id: "rss",
        name: "RSS",
        async fetch() {
          throw new Error("HTTP 503 from feed endpoint");
        },
      },
      f.library,
      { url: "https://example.com/feed", limit: 1 },
    ),
    /HTTP 503 from feed endpoint/,
  );
  assert.equal(await f.library.latest(), undefined);
});

test("a malformed fetch envelope fails before saving", async () => {
  let saves = 0;
  await assert.rejects(
    importSource(
      {
        id: "rss",
        name: "RSS",
        async fetch() {
          return { items: "not an array", issues: [] };
        },
      },
      {
        async save() {
          saves++;
          throw new Error("Unexpected save");
        },
      },
      { url: "https://example.com/feed", limit: 1 },
    ),
    /invalid fetch result/i,
  );
  assert.equal(saves, 0);
});

test("external cancellation aborts a non-cooperative fetch and prevents persistence", async () => {
  const controller = new AbortController();
  let signal;
  let saves = 0;
  const pending = importSource(
    {
      id: "rss",
      name: "RSS",
      async fetch(_input, context) {
        signal = context.signal;
        return new Promise(() => {});
      },
    },
    {
      async save() {
        saves++;
        throw new Error("Unexpected save");
      },
    },
    { url: "https://example.com/feed", limit: 1 },
    controller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(pending, /CANCELLED/i);
  assert.equal(signal.aborted, true);
  assert.equal(saves, 0);
});

test("cancellation during fetch and invalid inputs fail before library writes", async () => {
  let fetches = 0;
  let saves = 0;
  const module = {
    id: "rss",
    name: "RSS",
    async fetch() {
      fetches++;
      return { items: [], issues: [] };
    },
  };
  const library = {
    async save() {
      saves++;
      throw new Error("Unexpected save");
    },
  };
  for (const limit of [0, 11, 1.5, NaN])
    await assert.rejects(
      importSource(module, library, { url: "https://example.com/feed", limit }),
      /limit|input/i,
    );
  await assert.rejects(
    importSource(module, library, { url: "file:///private/feed", limit: 1 }),
    /url|input/i,
  );
  await assert.rejects(
    importSource(
      module,
      library,
      { url: "https://example.com/feed", limit: 1 },
      AbortSignal.abort(),
    ),
    /CANCELLED/i,
  );
  assert.equal(fetches, 0);
  assert.equal(saves, 0);
});

test("normalized URL and workflow provenance limits are enforced before fetch", async () => {
  let fetches = 0;
  let saves = 0;
  const module = {
    id: "rss",
    name: "RSS",
    async fetch() {
      fetches++;
      return { items: [], issues: [] };
    },
  };
  const library = {
    async save() {
      saves++;
      throw new Error("Unexpected save");
    },
  };

  await assert.rejects(
    importSource(module, library, {
      url: `https://example.com/${"é".repeat(2_000)}`,
      limit: 1,
    }),
    /normalized url exceeds 8,192 characters/i,
  );
  await assert.rejects(
    importSource(module, library, {
      url: `https://example.com/${"x".repeat(4_100)}`,
      limit: 1,
    }),
    /provenance metadata exceeds the 4,096-character library limit/i,
  );
  assert.equal(fetches, 0);
  assert.equal(saves, 0);
});

test("a duplicate feedUrl is omitted only when it would exceed the metadata limit", async (t) => {
  const f = await setup(t);
  const url = `https://example.com/${"x".repeat(2_050)}`;
  const result = await importSource(
    {
      id: "rss",
      name: "RSS",
      async fetch(input) {
        return { items: [candidate("large", { metadata: { feedUrl: input.url } })], issues: [] };
      },
    },
    f.library,
    { url, limit: 1 },
  );

  assert.equal(result.batch.items.length, 1);
  assert.equal(result.batch.items[0].metadata.sourceUrl, url);
  assert.equal(result.batch.items[0].metadata.sourceModule, "rss");
  assert.equal("feedUrl" in result.batch.items[0].metadata, false);
});

test("save failures propagate without returning a saved batch", async () => {
  await assert.rejects(
    importSource(
      {
        id: "rss",
        name: "RSS",
        async fetch() {
          return { items: [candidate()], issues: [] };
        },
      },
      {
        async save() {
          throw new Error("LIBRARY_WRITE_UNCERTAIN");
        },
      },
      { url: "https://example.com/feed", limit: 1 },
    ),
    /LIBRARY_WRITE_UNCERTAIN/,
  );
});
