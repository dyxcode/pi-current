import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SQLiteContentLibrary } from "../src/library/store.ts";
const now = "2026-01-01T00:00:00.000Z";
const item = (sourceId, text = "Fixture body") => ({
  sourceId,
  externalId: "same-id",
  url: "https://example.com/article",
  title: "Fixture",
  text,
  retrievedAt: now,
  discoveredAt: now,
  observedPosition: 1,
  sourceCompleteness: "unknown",
  truncated: false,
});
const request = (sourceId, text) => ({
  startedAt: now,
  requestedCount: 1,
  batch: {
    id: randomUUID(),
    sourceId,
    collectedAt: now,
    items: [item(sourceId, text)],
    failures: [],
    stopReason: "limit",
  },
});
test("identical external IDs from different plugins remain separate, versioned, and filterable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "current-source-library-"));
  const library = new SQLiteContentLibrary(root);
  t.after(async () => {
    await library.close();
    await rm(root, { recursive: true, force: true });
  });
  const a = await library.save(request("alpha"));
  const b = await library.save(request("beta"));
  assert.notEqual(a.items[0].itemId, b.items[0].itemId);
  assert.equal((await library.search({ query: "Fixture", source: "alpha" })).length, 1);
  assert.equal((await library.latest("beta")).sourceId, "beta");
  const changed = await library.save(request("alpha", "Updated body"));
  assert.notEqual(changed.items[0].versionId, a.items[0].versionId);
  assert.equal(
    (await library.read({ itemId: a.items[0].itemId, versionId: a.items[0].versionId })).text,
    "Fixture body",
  );
  await library.remove(a.items[0].itemId);
  assert.equal((await library.search({ query: "Fixture" })).length, 1);
});
