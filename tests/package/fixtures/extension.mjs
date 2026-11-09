import { discoverReading } from "__PACKAGE_ROOT__/src/reading/discover.ts";
import { addSource, readSources, writeSources } from "__PACKAGE_ROOT__/src/reading/sources.ts";
import { sourceIdFor } from "__PACKAGE_ROOT__/src/sources/import.ts";
import { extractDocument } from "__PACKAGE_ROOT__/src/web/extract.ts";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { mockPages } from "./page-harness.mjs";
import { feedUrl, feedResponse, hasConditionalValidator } from "./feed.mjs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openContentLibrary } from "pi-current/library";

export default async function () {
  const root = dirname(fileURLToPath(import.meta.url));
  const dataRoot = join(root, "runtime");
  const sources = [
    { name: "Fixture reading", url: feedUrl, enabled: true },
    { name: "Disabled", url: "https://example.com/disabled", enabled: false },
  ];
  const { requests } = mockPages(
    { mock },
    {
      response: feedResponse,
    },
  );
  await writeSources(dataRoot, sources);
  const sourceId = sourceIdFor(feedUrl);
  let library = openContentLibrary({ root: dataRoot });
  try {
    assert.equal(library.apiVersion, 2);
    assert.equal(typeof library.prepare, "function");
    assert.equal(typeof library.prepared, "function");

    const selected = await discoverReading(library, await readSources(dataRoot), {
      terms: ["article"],
      limit: 1,
    });
    assert.equal(selected.items.length, 1);
    const first = selected.items[0];
    assert.ok(first);
    assert.equal(first.item.title, "Synthetic article");
    assert.equal(first.sourceName, "Fixture reading");

    const prepared = await library.prepared(sourceId);
    assert.ok(prepared?.batch);
    assert.equal(prepared.batch.items.length, 2);
    assert.equal((await library.search({ query: "Synthetic" })).length, 2);
    assert.equal(prepared.batch.items[0]?.text, "Synthetic independent feed content.");
    assert.equal(prepared.batch.items[1]?.text, undefined);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.href, feedUrl);

    const repeated = await discoverReading(library, sources, { terms: ["article"], limit: 1 });
    assert.deepEqual(repeated.items[0]?.item.itemId, first.item.itemId);
    assert.deepEqual(repeated.items[0]?.item.versionId, first.item.versionId);
    assert.equal(requests.length, 2, "recommendation revalidates the prepared snapshot");
    assert.equal(requests[1]?.response.statusCode, 304);
    assert.ok(hasConditionalValidator(requests[1]));
    const revalidated = await library.prepared(sourceId);
    assert.equal(revalidated.batch.id, prepared.batch.id);

    const sourceItem = { ...prepared.batch.items[0] };
    delete sourceItem.itemId;
    delete sourceItem.versionId;
    const previousText = sourceItem.text;
    sourceItem.text = `${previousText} Revised.`;
    const revised = await library.save({
      batch: {
        id: randomUUID(),
        sourceId,
        collectedAt: new Date().toISOString(),
        items: [sourceItem],
        failures: [],
        stopReason: "complete",
      },
      requestedCount: 1,
      startedAt: new Date().toISOString(),
    });
    assert.equal(revised.items[0]?.itemId, prepared.batch.items[0]?.itemId);
    assert.notEqual(revised.items[0]?.versionId, prepared.batch.items[0]?.versionId);
    assert.deepEqual(await library.prepared(sourceId), revalidated);
    assert.equal(
      (
        await library.read({
          itemId: prepared.batch.items[0].itemId,
          versionId: prepared.batch.items[0].versionId,
        })
      )?.text,
      previousText,
    );

    await library.close();
    library = openContentLibrary({ root: dataRoot });
    assert.equal(library.apiVersion, 2);
    assert.deepEqual(await library.prepared(sourceId), revalidated);
    const reopenedSelection = await discoverReading(library, sources, {
      terms: ["article"],
      limit: 1,
    });
    assert.equal(reopenedSelection.items[0]?.item.itemId, first.item.itemId);
    assert.equal(reopenedSelection.items[0]?.item.versionId, first.item.versionId);
    assert.equal(requests.length, 3, "the persisted snapshot is revalidated after reopening");
    assert.equal(requests[2]?.response.statusCode, 304);
    assert.ok(hasConditionalValidator(requests[2]));
    assert.equal((await library.prepared(sourceId)).batch.id, prepared.batch.id);

    assert.equal((await library.search({ query: "Synthetic" })).length, 2);
    await assert.rejects(
      library.search({ query: "Synthetic" }, AbortSignal.abort()),
      /LIBRARY_CANCELLED/,
    );
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

    await library.close();
    await assert.rejects(library.search({ query: "Synthetic" }), /LIBRARY_CLOSED/);
    library = openContentLibrary({ root: dataRoot });
    assert.equal(await library.remove(prepared.batch.items[0].itemId), true);
    assert.equal((await library.search({ query: "Synthetic" })).length, 1);
    const addition = await addSource(dataRoot, {
      name: "Another source",
      url: "https://example.com/another-feed.xml",
    });
    assert.equal(addition.added, true);
    assert.equal((await readSources(dataRoot)).length, 3);
    const duplicate = await addSource(dataRoot, sources[1]);
    assert.equal(duplicate.added, false);
    assert.equal(duplicate.source.enabled, false);
  } finally {
    mock.restoreAll();
    await library.close();
  }
}
