import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SQLiteContentLibrary } from "../src/library/store.ts";
import { MAX_ARTICLE_BYTES, MAX_SUMMARY_CHARACTERS } from "../src/sources/content-limits.mjs";

const time = "2026-10-23T00:00:00.000Z";
function answer(overrides = {}) {
  return {
    externalId: "1",
    sourceId: "sample",
    url: "https://example.com/article/1",
    title: "推荐系统 research",
    text: 'AI 推荐 and 100% literal "quotes". 中文检索测试',
    author: "Synthetic",
    discoveredAt: time,
    retrievedAt: time,
    observedPosition: 1,
    sourceCompleteness: "unknown",
    truncated: false,
    ...overrides,
  };
}
function request(items = [answer()], overrides = {}) {
  return {
    batch: {
      id: randomUUID(),
      sourceId: "sample",
      collectedAt: time,
      items,
      failures: [],
      stopReason: "limit",
    },
    requestedCount: 5,
    startedAt: time,
    ...overrides,
  };
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-current-library-"));
  const store = new SQLiteContentLibrary(root);
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, path: join(root, "content.sqlite") };
}

test("empty reads are lazy and offline; save survives close/reopen with provenance", async (t) => {
  const { root, store, path } = await setup(t);
  assert.deepEqual(await store.search({ query: "推荐" }), []);
  assert.equal(await store.latest(), undefined);
  await assert.rejects(stat(path), { code: "ENOENT" });
  const req = request();
  const saved = await store.save(req);
  assert.equal(saved.items[0].externalId, "1");
  assert.ok(saved.items[0].itemId && saved.items[0].versionId);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await store.close();
  const reopened = new SQLiteContentLibrary(root);
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.latest(), saved);
  const item = await reopened.read({ itemId: saved.items[0].itemId });
  assert.equal(item.text, req.batch.items[0].text);
  assert.equal(item.discoveredAt, time);
});

test("deduplication, immutable old versions, idempotent runs and partial batches", async (t) => {
  const { store } = await setup(t);
  const req = request();
  const first = await store.save(req);
  assert.deepEqual(await store.save(req), first);
  const second = await store.save(request());
  assert.equal(second.items[0].itemId, first.items[0].itemId);
  assert.equal(second.items[0].versionId, first.items[0].versionId);
  const changed = await store.save(
    request([
      answer({ text: "Changed preview", truncated: true, sourceCompleteness: "known-partial" }),
    ]),
  );
  assert.notEqual(changed.items[0].versionId, first.items[0].versionId);
  assert.equal((await store.search({ query: "推荐" })).length, 1);
  assert.equal((await store.search({ query: "中文检索" })).length, 0);
  const old = await store.read({
    itemId: first.items[0].itemId,
    versionId: first.items[0].versionId,
  });
  assert.equal(old.truncated, false);
  assert.match(old.text, /中文检索/);
  const clipped = await store.read({ itemId: first.items[0].itemId, maxCharacters: 3 });
  assert.equal(clipped.text, "Cha");
  assert.equal(clipped.displayTruncated, true);
  await store.save(
    request([], {
      batch: {
        id: randomUUID(),
        sourceId: "sample",
        collectedAt: time,
        items: [],
        failures: [],
        stopReason: "LOGIN_REQUIRED",
      },
    }),
  );
  assert.equal((await store.latest()).id, changed.id);
  await assert.rejects(
    store.save({ ...req, batch: { ...req.batch, stopReason: "NETWORK_ERROR" } }),
    /LIBRARY_CONFLICT/,
  );
});

test("search accepts literal English, CJK, short terms and punctuation without FTS syntax", async (t) => {
  const { store } = await setup(t);
  await store.save(request());
  for (const query of ["AI", "推荐", "中文检索", "research", "100%", '"quotes"'])
    assert.equal((await store.search({ query })).length, 1, query);
  for (const query of ["nonexistent", "*", "OR", '" OR 1=1 --'])
    assert.equal((await store.search({ query })).length, 0, query);
  await assert.rejects(store.search({ query: "  " }), /LIBRARY_INVALID/);
  await assert.rejects(store.search({ query: "AI", limit: 1000 }), /LIBRARY_INVALID/);
  await assert.rejects(store.search({ query: "AI", source: "INVALID" }), /LIBRARY_INVALID/);
});

test("single-item removal clears versions, search and batch references, preserves login", async (t) => {
  const { store, root } = await setup(t);
  await mkdir(join(root, "browser"));
  await writeFile(join(root, "browser", "sentinel"), "login");
  const saved = await store.save(request());
  await store.save(request([answer({ text: "Another version" })]));
  assert.equal(await store.remove(saved.items[0].itemId), true);
  assert.equal(await store.remove(saved.items[0].itemId), false);
  assert.equal(await store.read({ itemId: saved.items[0].itemId }), undefined);
  assert.deepEqual(await store.search({ query: "推荐" }), []);
  assert.equal(await store.latest(), undefined);
  assert.equal(await readFile(join(root, "browser", "sentinel"), "utf8"), "login");
});

test("save is atomic when SQLite rejects a later answer; earlier batch remains", async (t) => {
  const { store, path } = await setup(t);
  const saved = await store.save(request());
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TRIGGER fixture_fault BEFORE INSERT ON items WHEN NEW.external_id='3' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
  );
  db.close();
  await assert.rejects(
    store.save(
      request([
        answer({ text: "must rollback" }),
        answer({ externalId: "3", url: "https://example.com/article/3", observedPosition: 2 }),
      ]),
    ),
    /LIBRARY_/,
  );
  assert.equal((await store.read({ itemId: saved.items[0].itemId })).text, answer().text);
  assert.equal((await store.latest()).id, saved.id);
});

test("corrupt and future databases fail closed without replacement; missing removal stays lazy", async (t) => {
  const { store, path } = await setup(t);
  assert.equal(await store.remove(randomUUID()), false);
  await assert.rejects(stat(path), { code: "ENOENT" });
  await writeFile(path, "broken");
  await assert.rejects(store.search({ query: "AI" }), /LIBRARY_/);
  assert.equal(await readFile(path, "utf8"), "broken");
  await rm(path);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version=999");
  db.close();
  await assert.rejects(store.save(request()), /LIBRARY_SCHEMA/);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("PRAGMA user_version").get().user_version, 999);
  check.close();
});

test("busy writes report a storage failure and recover after lock release", async (t) => {
  const { store, path } = await setup(t);
  await store.save(request());
  const db = new DatabaseSync(path);
  db.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(store.save(request()), /LIBRARY_BUSY/);
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
  await store.save(request());
});

test("cancelled reads and closed stores are explicit failures", async (t) => {
  const { store } = await setup(t);
  await assert.rejects(store.search({ query: "AI" }, AbortSignal.abort()), /LIBRARY_CANCELLED/);
  await store.close();
  await assert.rejects(store.search({ query: "AI" }), /LIBRARY_CLOSED/);
});

test("database path rejects symlinks and repository/vault locations", async (t) => {
  const { store, root, path } = await setup(t);
  const target = join(root, "target");
  await writeFile(target, "untouched");
  await symlink(target, path);
  await assert.rejects(store.save(request()), /LIBRARY_PATH/);
  assert.equal(await readFile(target, "utf8"), "untouched");
  await rm(path);
  await mkdir(join(root, ".obsidian"));
  await assert.rejects(store.save(request()), /LIBRARY_PATH/);
});

test("cancellation stops a long SQLite statement and rolls back its batch", async (t) => {
  const { store, path } = await setup(t);
  const saved = await store.save(request());
  const db = new DatabaseSync(path);
  db.exec(`CREATE TRIGGER fixture_slow BEFORE INSERT ON items WHEN NEW.external_id='3' BEGIN
    SELECT sum(x) FROM (WITH RECURSIVE slow(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM slow WHERE x<100000000) SELECT x FROM slow);
    END`);
  const controller = new AbortController();
  const pending = store.save(
    request([
      answer({ text: "must roll back on cancellation" }),
      answer({ externalId: "3", url: "https://example.com/article/3", observedPosition: 2 }),
    ]),
    controller.signal,
  );
  const timer = setTimeout(() => controller.abort(), 150);
  const started = Date.now();
  try {
    await assert.rejects(pending, /LIBRARY_WRITE_UNCERTAIN/);
  } finally {
    clearTimeout(timer);
    db.close();
  }
  assert.ok(
    Date.now() - started < 2000,
    "cancellation must stop the SQLite operation, not wait for it to finish",
  );
  const cleanup = new DatabaseSync(path);
  cleanup.exec("DROP TRIGGER fixture_slow");
  cleanup.close();
  assert.equal((await store.latest()).id, saved.id);
  assert.equal((await store.read({ itemId: saved.items[0].itemId })).text, answer().text);
});

test("an incompatible FTS schema is rejected before mutation", async (t) => {
  const { store, path } = await setup(t);
  const saved = await store.save(request());
  const db = new DatabaseSync(path);
  db.exec(
    "DROP TABLE library_fts; CREATE TABLE library_fts(title TEXT, body TEXT, version_id TEXT)",
  );
  db.close();
  await assert.rejects(store.remove(saved.items[0].itemId), /LIBRARY_SCHEMA/);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("SELECT count(*) AS n FROM items").get().n, 1);
  check.close();
});

test("deadline terminates a native SQLite statement without reporting an empty result", async (t) => {
  const { store, path } = await setup(t);
  const saved = await store.save(request());
  const db = new DatabaseSync(path);
  db.exec(`CREATE TRIGGER fixture_deadline AFTER INSERT ON collection_runs BEGIN
    SELECT sum(x) FROM (WITH RECURSIVE slow(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM slow WHERE x<1000000000) SELECT x FROM slow);
    END`);
  db.close();
  const started = Date.now();
  await assert.rejects(store.save(request()), /LIBRARY_WRITE_UNCERTAIN/);
  assert.ok(Date.now() - started < 7000);
  assert.equal((await store.latest()).id, saved.id);
});

test("an empty database left before first commit reads as empty and can be initialized later", async (t) => {
  const { store, path } = await setup(t);
  // A cancelled first transaction can leave SQLite's file without a committed schema.
  const db = new DatabaseSync(path);
  db.close();
  const before = await readFile(path);
  assert.deepEqual(await store.search({ query: "AI" }), []);
  assert.equal(await store.latest(), undefined);
  assert.equal(await store.read({ itemId: randomUUID() }), undefined);
  assert.equal(await store.remove(randomUUID()), false);
  assert.deepEqual(await readFile(path), before);
  await store.save(request());
  assert.equal((await store.search({ query: "AI" })).length, 1);
});

test("API acquisition evidence survives persistence and does not deduplicate into an older browser version", async (t) => {
  const { store } = await setup(t);
  const old = await store.save(request());
  const api = await store.save(
    request([answer({ metadata: { retrievalMethod: "local-api", apiReportedTruncated: false } })]),
  );
  assert.notEqual(api.items[0].versionId, old.items[0].versionId);
  const saved = await store.read({ itemId: api.items[0].itemId });
  assert.equal(saved.metadata.retrievalMethod, "local-api");
  assert.equal(saved.metadata.apiReportedTruncated, false);
  await assert.rejects(
    store.save(request([answer({ retrievalMethod: "mobile-api", apiReportedTruncated: "false" })])),
    /LIBRARY_INVALID/,
  );
});

test("long multilingual article bodies remain intact and searchable beyond the excerpt", async (t) => {
  const { store } = await setup(t);
  const tail = "FULL_ARTICLE_TAIL_7f93";
  const body = `${"中文🧪 multilingual body ".repeat(4000)}${tail}`;
  assert.ok(body.length > 50000);
  const saved = await store.save(request([answer({ text: body })]));
  const itemId = saved.items[0].itemId;

  const matches = await store.search({ query: tail });
  assert.equal(matches.length, 1);
  assert.match(matches[0].text, new RegExp(tail));
  assert.equal(matches[0].displayTruncated, true);
  assert.equal(matches[0].truncated, false);
  assert.equal(matches[0].sourceCompleteness, "unknown");

  const full = await store.read({ itemId, maxCharacters: MAX_ARTICLE_BYTES });
  assert.equal(full.text, body);
  assert.equal(full.displayTruncated, false);
  assert.equal(full.truncated, false);
  assert.equal(full.sourceCompleteness, "unknown");
});

test("a batch over 25,000 characters saves every requested item in full", async (t) => {
  const { store } = await setup(t);
  const items = Array.from({ length: 10 }, (_, index) =>
    answer({
      externalId: String(index + 1),
      url: `https://example.com/article/${index + 1}`,
      observedPosition: index + 1,
      text: `BATCH_ITEM_${index + 1}_${"界".repeat(3000)}_END_${index + 1}`,
    }),
  );
  assert.ok(items.reduce((total, item) => total + Array.from(item.text).length, 0) > 25000);

  const saved = await store.save(request(items, { requestedCount: items.length }));
  assert.equal(saved.items.length, items.length);
  for (let index = 0; index < items.length; index++) {
    const stored = await store.read({
      itemId: saved.items[index].itemId,
      maxCharacters: MAX_ARTICLE_BYTES,
    });
    assert.equal(stored.text, items[index].text, `item ${index + 1} body`);
    assert.equal(stored.displayTruncated, false, `item ${index + 1} display`);
  }
  assert.equal((await store.search({ query: "BATCH_ITEM_10" })).length, 1);
});

test("oversized UTF-8 article bodies are rejected before the database is created", async (t) => {
  const { store, path } = await setup(t);
  const tooLarge = "界".repeat(Math.floor(MAX_ARTICLE_BYTES / 3) + 1);
  await assert.rejects(store.save(request([answer({ text: tooLarge })])), /LIBRARY_INVALID/);
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("optional summaries are preserved, versioned, and validated without changing summary-less versions", async (t) => {
  const { store, path } = await setup(t);
  const withoutSummary = await store.save(request());
  const sameWithoutSummary = await store.save(request());
  assert.equal(sameWithoutSummary.items[0].versionId, withoutSummary.items[0].versionId);
  assert.equal((await store.read({ itemId: withoutSummary.items[0].itemId })).summary, undefined);
  const legacyHash = createHash("sha256")
    .update(
      JSON.stringify([
        answer().url,
        answer().title,
        answer().author ?? null,
        answer().text,
        answer().sourceCompleteness,
        answer().truncated,
        answer().metadata ?? null,
      ]),
    )
    .digest("hex");
  const db = new DatabaseSync(path);
  try {
    assert.equal(
      db.prepare("SELECT hash FROM item_versions WHERE id=?").get(withoutSummary.items[0].versionId)
        .hash,
      legacyHash,
    );
  } finally {
    db.close();
  }

  const summary = `  摘要🧪${"概述界 ".repeat(600)} end  `;
  assert.ok(Array.from(summary).length <= MAX_SUMMARY_CHARACTERS);
  const withSummary = await store.save(request([answer({ summary })]));
  assert.notEqual(withSummary.items[0].versionId, withoutSummary.items[0].versionId);
  assert.equal((await store.read({ itemId: withSummary.items[0].itemId })).summary, summary);

  const revisedSummary = await store.save(request([answer({ summary: `${summary}!` })]));
  assert.notEqual(revisedSummary.items[0].versionId, withSummary.items[0].versionId);
  assert.equal(
    (await store.read({ itemId: revisedSummary.items[0].itemId })).summary,
    `${summary}!`,
  );

  await assert.rejects(store.save(request([answer({ summary: 42 })])), /LIBRARY_INVALID/);
  await assert.rejects(
    store.save(request([answer({ summary: "界".repeat(MAX_SUMMARY_CHARACTERS + 1) })])),
    /LIBRARY_INVALID/,
  );
  await assert.rejects(
    store.save(request([answer({ unexpectedSummary: "not allowlisted" })])),
    /LIBRARY_INVALID/,
  );
});
