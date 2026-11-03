import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openContentLibrary } from "../src/library/index.ts";

const observed = "2026-11-03T01:00:00.000Z";
const retrieved = "2026-11-03T02:00:00.000Z";
const candidate = (extra = {}) => ({
  sourceId: "sample",
  externalId: "one",
  url: "https://example.com/one",
  title: "Candidate title",
  discoveredAt: observed,
  ...extra,
});
const request = (items) => ({
  batch: {
    id: randomUUID(),
    sourceId: items[0].sourceId,
    collectedAt: observed,
    items,
    failures: [],
    stopReason: "complete",
  },
  requestedCount: items.length,
  startedAt: observed,
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "library-candidates-"));
  const library = openContentLibrary({ root });
  t.after(async () => {
    await library.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, library };
}

test("candidate saves survive reopening, retain absent bodies and search title/summary offline", async (t) => {
  const { root, library } = await fixture(t);
  const req = request([
    candidate(),
    candidate({ externalId: "two", summary: '检索线索 100% "literal"' }),
  ]);
  const saved = await library.save(req);
  assert.deepEqual(await library.save(req), saved);
  await library.close();
  const reopened = openContentLibrary({ root });
  t.after(() => reopened.close());
  assert.equal(reopened.apiVersion, 2);
  for (const value of (await reopened.latest()).items) {
    assert.equal(value.text, undefined);
    assert.equal(value.retrievedAt, undefined);
    assert.equal(value.sourceCompleteness, undefined);
  }
  assert.equal((await reopened.search({ query: "Candidate" })).length, 2);
  for (const query of ["检索", "检索线索", "100%", '"literal"']) {
    const [found] = await reopened.search({ query });
    assert.equal(found.itemId, saved.items.find((item) => item.externalId === "two").itemId);
    assert.equal(found.text, undefined);
    assert.equal(found.summary, req.batch.items[1].summary);
  }
  assert.deepEqual(await reopened.search({ query: "Candidate", source: "other" }), []);
  assert.equal((await reopened.read({ itemId: saved.items[0].itemId })).text, undefined);
});

test("explicit body updates preserve identity/history while omitted body and summary retain content", async (t) => {
  const { library } = await fixture(t);
  const first = (await library.save(request([candidate({ summary: "Original summary" })])))
    .items[0];
  const repeat = (await library.save(request([candidate()]))).items[0];
  assert.equal(repeat.versionId, first.versionId);
  const article = candidate({
    text: "Acquired body",
    retrievedAt: retrieved,
    sourceCompleteness: "unknown",
    truncated: false,
  });
  const enriched = (await library.save(request([article]))).items[0];
  assert.equal(enriched.itemId, first.itemId);
  assert.notEqual(enriched.versionId, first.versionId);
  assert.equal(enriched.summary, "Original summary");
  const update = (
    await library.save(
      request([
        candidate({ summary: "Updated summary", discoveredAt: "2026-11-03T03:00:00.000Z" }),
      ]),
    )
  ).items[0];
  assert.equal(update.text, "Acquired body");
  assert.equal(update.retrievedAt, retrieved);
  assert.equal(update.summary, "Updated summary");
  assert.equal(
    (await library.read({ itemId: first.itemId, versionId: first.versionId })).text,
    undefined,
  );
  assert.equal(
    (await library.read({ itemId: first.itemId, versionId: enriched.versionId })).summary,
    "Original summary",
  );
  const partial = (
    await library.save(
      request([
        {
          ...article,
          text: "New partial body",
          sourceCompleteness: "known-partial",
          truncated: true,
        },
      ]),
    )
  ).items[0];
  assert.equal(partial.text, "New partial body");
  assert.equal(partial.summary, "Updated summary");
  assert.equal((await library.search({ query: "New partial" }))[0].itemId, first.itemId);
  const cleared = (await library.save(request([candidate({ summary: "" })]))).items[0];
  assert.equal(cleared.summary, "");
  assert.equal(cleared.text, "New partial body");
  assert.notEqual(cleared.versionId, partial.versionId);
});

test("candidate identity stays source-scoped and deletion removes versions and search results", async (t) => {
  const { library } = await fixture(t);
  const first = (await library.save(request([candidate({ summary: "Shared summary" })]))).items[0];
  const other = (
    await library.save(request([candidate({ sourceId: "other", summary: "Shared summary" })]))
  ).items[0];
  assert.notEqual(first.itemId, other.itemId);
  await library.save(request([candidate({ summary: "Changed summary" })]));
  assert.equal(await library.remove(first.itemId), true);
  assert.equal(await library.read({ itemId: first.itemId, versionId: first.versionId }), undefined);
  assert.deepEqual(await library.search({ query: "Changed" }), []);
  assert.deepEqual(
    (await library.search({ query: "Shared" })).map((v) => v.itemId),
    [other.itemId],
  );
});

test("library rejects ambiguous or incomplete body evidence before writing", async (t) => {
  const { library } = await fixture(t);
  for (const value of [
    candidate({ text: "" }),
    candidate({ text: "Body" }),
    candidate({ text: null }),
    candidate({ retrievedAt: retrieved }),
    candidate({ sourceCompleteness: "unknown" }),
    candidate({ truncated: false }),
    { ...candidate(), discoveredAt: undefined },
  ])
    await assert.rejects(library.save(request([value])), /LIBRARY_INVALID/);
  assert.deepEqual(await library.search({ query: "Candidate" }), []);
});
