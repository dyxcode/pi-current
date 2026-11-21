import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { openContentLibrary } from "./node_modules/pi-current/dist/library-api/library/index.js";
import { extractDocument } from "./node_modules/pi-current/src/web/extract.ts";

async function verify(pi) {
  assert.ok(process.versions.bun);
  assert.deepEqual(
    pi
      .getAllTools()
      .map(({ name }) => name)
      .filter((name) => name.startsWith("current_"))
      .sort(),
    [
      "current_library_read",
      "current_library_remove",
      "current_library_search",
      "current_reading_find",
      "current_source_add",
      "current_web_read",
      "current_web_search",
    ],
  );
  const library = openContentLibrary({ root: process.env.PI_CURRENT_PACKAGE_LIBRARY_ROOT });
  const time = "2026-11-21T00:00:00.000Z";
  const summary = "Synthetic 中文检索";
  try {
    const saved = await library.save({
      batch: {
        id: randomUUID(),
        sourceId: "fixture",
        collectedAt: time,
        items: [
          {
            sourceId: "fixture",
            externalId: "one",
            url: "https://example.com/article",
            title: "Fixture article",
            summary,
            discoveredAt: time,
          },
        ],
        failures: [],
        stopReason: "complete",
      },
      requestedCount: 1,
      startedAt: time,
    });
    const [{ itemId, versionId }] = saved.items;
    assert.deepEqual(
      (await library.search({ query: "中文检索" })).map((item) => item.itemId),
      [itemId],
    );
    assert.equal((await library.read({ itemId, versionId }))?.summary, summary);
  } finally {
    await library.close();
  }
  const body =
    "Synthetic extraction marker. This paragraph explains how a library can keep articles available offline. Titles, summaries and source links remain readable after the application restarts. This sample is long enough to be recognized as an article by the actual HTML extraction worker.";
  const extracted = await extractDocument(
    {
      bytes: new TextEncoder().encode(
        `<!doctype html><title>Fixture</title><article><p>${body}</p></article>`,
      ),
      url: "https://example.com/article",
      contentType: "text/html; charset=utf-8",
    },
    AbortSignal.timeout(5000),
  );
  assert.match(extracted.text, /Synthetic extraction marker/);
}

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    let outcome;
    try {
      await verify(pi);
      outcome = { passed: true };
    } catch (error) {
      outcome = { passed: false, error: String(error.stack ?? error) };
    }
    await writeFile(process.env.PI_CURRENT_PACKAGE_RESULT, JSON.stringify(outcome));
    ctx.shutdown();
  });
}
