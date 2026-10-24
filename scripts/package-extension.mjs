import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceRegistry } from "__PACKAGE_ROOT__/src/sources/registry.ts";
import { SQLiteContentLibrary } from "__PACKAGE_ROOT__/src/library/store.ts";
import { collectAndSave } from "__PACKAGE_ROOT__/src/sources/collection.ts";
import { extractDocument } from "__PACKAGE_ROOT__/src/web/extract.ts";

export default async function () {
  const root = dirname(fileURLToPath(import.meta.url));
  const registry = new SourceRegistry({ root: join(root, "runtime") });
  const library = new SQLiteContentLibrary(registry.root);
  try {
    await registry.register(join(root, "external-plugins/sample.mjs"));
    await registry.register(join(root, "external-plugins/sample.ts"));
    assert.equal(
      (await registry.read("typescript", "https://example.com/a", 2000)).text,
      "Synthetic independent plugin dependency.",
    );
    const outcome = await collectAndSave(registry, library, { sourceId: "sample", limit: 1 });
    assert.equal(outcome.storage.status, "saved");
    assert.equal((await library.search({ query: "Synthetic" })).length, 1);
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
