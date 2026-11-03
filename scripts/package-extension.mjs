import { collectAndSave } from "__PACKAGE_ROOT__/src/sources/collection.ts";
import { SourceRegistry } from "__PACKAGE_ROOT__/src/sources/registry.ts";
import { extractDocument } from "__PACKAGE_ROOT__/src/web/extract.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openContentLibrary } from "pi-current/library";

export default async function () {
  const root = dirname(fileURLToPath(import.meta.url));
  const registry = new SourceRegistry({ root: join(root, "runtime") });
  const library = openContentLibrary({ root: registry.root });
  try {
    assert.equal(library.apiVersion, 2);
    await registry.register(join(root, "external-plugins/sample.mjs"));
    await registry.register(join(root, "external-plugins/sample.ts"));
    assert.equal(
      (await registry.read("typescript", "https://example.com/a", 2000)).text,
      "Synthetic independent plugin dependency.",
    );
    const outcome = await collectAndSave(registry, library, { sourceId: "sample", limit: 1 });
    assert.equal(outcome.storage.status, "saved");
    assert.equal((await library.search({ query: "Synthetic" })).length, 1);
    const first = outcome.storage.batch.items[0];
    const sourceItem = outcome.batch.items[0];
    assert.ok(first && sourceItem);
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
    await registry.remove("sample");
    assert.equal(
      (await registry.list()).some((source) => source.id === "sample"),
      false,
    );
    assert.equal((await library.search({ query: "Synthetic" })).length, 1);
    await assert.rejects(
      library.search({ query: "Synthetic" }, AbortSignal.abort()),
      /LIBRARY_CANCELLED/,
    );
    await library.close();
    await assert.rejects(library.search({ query: "Synthetic" }), /LIBRARY_CLOSED/);
    const reopened = openContentLibrary({ root: registry.root });
    assert.equal(reopened.apiVersion, 2);
    assert.equal(
      (await reopened.latest("sample"))?.items[0]?.versionId,
      revised.items[0]?.versionId,
    );
    assert.equal(await reopened.remove(first.itemId), true);
    assert.equal((await reopened.search({ query: "Synthetic" })).length, 0);
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
    await Promise.allSettled([registry.close(), library.close()]);
  }
}
