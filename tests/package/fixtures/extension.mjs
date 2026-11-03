import { importFeed } from "__PACKAGE_ROOT__/src/sources/import.ts";
import { extractDocument } from "__PACKAGE_ROOT__/src/web/extract.ts";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { mockPages } from "./page-harness.mjs";
import { feedUrl, feedXml } from "./feed.mjs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openContentLibrary } from "pi-current/library";

export default async function () {
  const root = dirname(fileURLToPath(import.meta.url));
  const dataRoot = join(root, "runtime");
  const library = openContentLibrary({ root: dataRoot });
  const { requests } = mockPages(
    { mock },
    {
      response: () => ({ body: feedXml, headers: { "content-type": "application/rss+xml" } }),
    },
  );
  try {
    assert.equal(library.apiVersion, 2);
    const outcome = await importFeed(library, { url: feedUrl });
    assert.equal(outcome.batch.items.length, 2);
    assert.equal(outcome.issues.length, 0);
    assert.equal((await library.search({ query: "Synthetic" })).length, 2);
    assert.equal(outcome.batch.items[0]?.text, "Synthetic independent feed content.");
    assert.equal(outcome.batch.items[1]?.text, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.href, feedUrl);
    const first = outcome.batch.items[0];
    assert.ok(first);
    const sourceItem = { ...first };
    delete sourceItem.itemId;
    delete sourceItem.versionId;
    const revised = await library.save({
      batch: {
        ...outcome.batch,
        id: randomUUID(),
        collectedAt: new Date().toISOString(),
        items: [{ ...sourceItem, text: `${sourceItem.text} Revised.` }],
      },
      requestedCount: 1,
      startedAt: new Date().toISOString(),
    });
    assert.equal(revised.items[0]?.itemId, first.itemId);
    assert.notEqual(revised.items[0]?.versionId, first.versionId);
    assert.equal(
      (await library.read({ itemId: first.itemId, versionId: first.versionId }))?.text,
      sourceItem.text,
    );
    assert.equal((await library.search({ query: "Synthetic" })).length, 2);
    await assert.rejects(
      library.search({ query: "Synthetic" }, AbortSignal.abort()),
      /LIBRARY_CANCELLED/,
    );
    await library.close();
    await assert.rejects(library.search({ query: "Synthetic" }), /LIBRARY_CLOSED/);
    const reopened = openContentLibrary({ root: dataRoot });
    assert.equal(reopened.apiVersion, 2);
    assert.equal(
      (await reopened.latest(outcome.sourceId))?.items[0]?.versionId,
      revised.items[0]?.versionId,
    );
    assert.equal(await reopened.remove(first.itemId), true);
    assert.equal((await reopened.search({ query: "Synthetic" })).length, 1);
    await reopened.close();
    const html =
      "<html><head><title>Synthetic extraction</title></head><body><article><h1>Synthetic extraction</h1>" +
      "<p>Synthetic article content verifies independent extraction worker dependencies and the public package runtime.</p>".repeat(
        12,
      ) +
      "</article></body></html>";
    const extracted = await extractDocument(
      { bytes: Buffer.from(html), url: "https://example.com/a", contentType: "text/html" },
      AbortSignal.timeout(10000),
    );
    assert.equal(extracted.contentKind, "extracted-article");
    assert.match(extracted.text, /Synthetic article content/);
  } finally {
    mock.restoreAll();
    await library.close();
  }
}
