import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { openContentLibrary } from "../../../src/library/index.ts";

const now = "2026-11-19T00:00:00Z";
const article = {
  sourceId: "sample",
  externalId: "one",
  url: "https://example.com/one",
  title: "Synthetic reading",
  text: "中文检索测试 library worker",
  retrievedAt: now,
  sourceCompleteness: "unknown",
  truncated: false,
};

function batch(items) {
  return {
    batch: {
      id: randomUUID(),
      sourceId: "sample",
      collectedAt: now,
      items,
      failures: [],
      stopReason: "complete",
    },
    requestedCount: items.length,
    startedAt: now,
  };
}

async function waitForWriter(db) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      assert.equal(error.errcode, 5, String(error));
      return;
    }
    db.exec("ROLLBACK");
    await delay(10);
  }
  assert.fail("SQLite worker did not acquire its write lock");
}

async function verifyLibrary(root) {
  const library = openContentLibrary({ root });
  let saved;
  try {
    saved = await library.save(batch([article]));
  } finally {
    await library.close();
  }
  const { itemId, versionId } = saved.items[0];
  const reopened = openContentLibrary({ root });
  try {
    assert.deepEqual(
      (await reopened.search({ query: "中文检索" })).map((item) => item.itemId),
      [itemId],
    );
    assert.equal((await reopened.read({ itemId, versionId })).text, article.text);

    const db = new DatabaseSync(join(root, "content.sqlite"));
    const controller = new AbortController();
    try {
      db.exec(`PRAGMA busy_timeout = 0;
        CREATE TRIGGER fixture_slow BEFORE INSERT ON items WHEN NEW.external_id = 'two' BEGIN
          SELECT sum(x) FROM (WITH RECURSIVE slow(x) AS
            (VALUES(0) UNION ALL SELECT x+1 FROM slow WHERE x<100000000) SELECT x FROM slow);
        END`);
      const pending = reopened.save(
        batch([
          { ...article, text: "Must roll back" },
          { ...article, externalId: "two", url: "https://example.com/two", observedPosition: 2 },
        ]),
        controller.signal,
      );
      const outcome = pending.then(
        () => undefined,
        (error) => error,
      );
      try {
        await waitForWriter(db);
      } finally {
        controller.abort();
        assert.match(String(await outcome), /LIBRARY_WRITE_UNCERTAIN/);
      }
      db.exec("DROP TRIGGER fixture_slow");
    } finally {
      db.close();
    }
    assert.equal((await reopened.latest()).id, saved.id);
    assert.equal((await reopened.read({ itemId })).text, article.text);
    assert.equal(await reopened.remove(itemId), true);
    assert.deepEqual(await reopened.search({ query: "中文检索" }), []);
  } finally {
    await reopened.close();
  }
}

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    const result = { runtime: process.versions.bun ? "bun" : "node" };
    try {
      await verifyLibrary(join(ctx.cwd, "library"));
    } catch (error) {
      result.error = error.stack ?? String(error);
    }
    await writeFile(join(ctx.cwd, "result.json"), JSON.stringify(result));
    ctx.shutdown();
  });
}
