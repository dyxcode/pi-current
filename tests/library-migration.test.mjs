import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SQLiteContentLibrary } from "../src/library/store.ts";

const time = "2026-10-23T00:00:00.000Z";
const priorTime = "2026-10-22T00:00:00.000Z";
const itemId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const priorVersionId = "44444444-4444-4444-8444-444444444444";
const priorRunId = "55555555-5555-4555-8555-555555555555";
const legacyItem = {
  sourceId: "sample",
  externalId: "legacy-1",
  url: "https://example.com/legacy",
  title: "Legacy saved article",
  summary: "Distinctive migration summary Ä phrase",
  text: "Exact legacy body bytes: CAFÉ and 中文.",
  author: "Synthetic fixture",
  retrievedAt: time,
  discoveredAt: time,
  observedPosition: 2,
  sourceCompleteness: "unknown",
  truncated: false,
};
const priorItem = {
  ...legacyItem,
  summary: "Earlier saved summary",
  text: "Earlier exact body bytes: Ñandú.",
  retrievedAt: priorTime,
  discoveredAt: priorTime,
};

// This is the shipped v1 schema, kept inline so the fixture remains historical
// after schema.mjs moves forward.
const schemaV1 = `
CREATE TABLE items (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, url TEXT NOT NULL, latest_version_id TEXT,
 first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, UNIQUE(source, external_id)
) STRICT;
CREATE TABLE item_versions (
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
 hash TEXT NOT NULL, payload TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
 UNIQUE(item_id, hash)
) STRICT;
CREATE TABLE collection_runs (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, hash TEXT NOT NULL, requested_count INTEGER NOT NULL,
 started_at TEXT NOT NULL, completed_at TEXT NOT NULL, saved_count INTEGER NOT NULL,
 failures TEXT NOT NULL, stop_reason TEXT NOT NULL
) STRICT;
CREATE TABLE collection_items (
 run_id TEXT NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES item_versions(id) ON DELETE CASCADE,
 discovered_at TEXT NOT NULL, retrieved_at TEXT NOT NULL, position INTEGER NOT NULL,
 PRIMARY KEY(run_id, item_id)
) STRICT;
CREATE INDEX observations_by_item ON collection_items(item_id);
CREATE INDEX versions_by_item ON item_versions(item_id);
CREATE VIRTUAL TABLE library_fts USING fts5(title, body, version_id UNINDEXED, tokenize='trigram');
PRAGMA user_version=1;
`;

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function versionHash(item) {
  return digest([
    item.url,
    item.title,
    item.author ?? null,
    item.text,
    item.sourceCompleteness,
    item.truncated,
    item.metadata ?? null,
    ...(item.summary === undefined ? [] : [item.summary]),
  ]);
}

async function seedLegacyDatabase(t, { incompatibleFts = false, malformedPayload = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-current-library-v1-"));
  const path = join(root, "content.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = malformedPayload ? "not-json" : JSON.stringify(legacyItem);
  const hash = versionHash(legacyItem);
  const db = new DatabaseSync(path);
  db.exec(schemaV1);
  db.prepare("INSERT INTO items VALUES (?,?,?,?,?,?,?)").run(
    itemId,
    legacyItem.sourceId,
    legacyItem.externalId,
    legacyItem.url,
    versionId,
    priorTime,
    time,
  );
  for (const [entry, entryVersionId] of [
    [priorItem, priorVersionId],
    [legacyItem, versionId],
  ]) {
    db.prepare("INSERT INTO item_versions VALUES (?,?,?,?,?,?)").run(
      entryVersionId,
      itemId,
      versionHash(entry),
      entryVersionId === versionId ? payload : JSON.stringify(entry),
      entry.title,
      entry.text,
    );
  }
  for (const [entryRunId, entryTime] of [
    [priorRunId, priorTime],
    [runId, time],
  ]) {
    db.prepare("INSERT INTO collection_runs VALUES (?,?,?,?,?,?,?,?,?)").run(
      entryRunId,
      legacyItem.sourceId,
      `legacy-${entryRunId}`,
      5,
      entryTime,
      entryTime,
      1,
      "[]",
      "complete",
    );
  }
  for (const [entryRunId, entryVersionId, entry] of [
    [priorRunId, priorVersionId, priorItem],
    [runId, versionId, legacyItem],
  ]) {
    db.prepare("INSERT INTO collection_items VALUES (?,?,?,?,?,?)").run(
      entryRunId,
      itemId,
      entryVersionId,
      entry.discoveredAt,
      entry.retrievedAt,
      entry.observedPosition,
    );
  }
  if (incompatibleFts) {
    db.exec("DROP TABLE library_fts");
    db.exec(
      "CREATE VIRTUAL TABLE library_fts USING fts5(title, body, version_id UNINDEXED, tokenize='unicode61')",
    );
  }
  for (const [entry, entryVersionId] of [
    [priorItem, priorVersionId],
    [legacyItem, versionId],
  ])
    db.prepare("INSERT INTO library_fts(title,body,version_id) VALUES (?,?,?)").run(
      entry.title.toLowerCase(),
      entry.text.toLowerCase(),
      entryVersionId,
    );
  db.close();
  return { root, path, payload, hash };
}

function snapshot(path) {
  const db = new DatabaseSync(path);
  try {
    return {
      version: db.prepare("PRAGMA user_version").get().user_version,
      item: db.prepare("SELECT * FROM items WHERE id=?").get(itemId),
      versionRows: db
        .prepare("SELECT * FROM item_versions WHERE item_id=? ORDER BY id")
        .all(itemId)
        .map((row) => ({ ...row })),
      observations: db
        .prepare("SELECT * FROM collection_items WHERE item_id=? ORDER BY run_id")
        .all(itemId)
        .map((row) => ({ ...row })),
      foreignKeyErrors: db.prepare("PRAGMA foreign_key_check").all(),
      foreignKeys: ["item_versions", "collection_items"].map((table) =>
        db
          .prepare(`PRAGMA foreign_key_list(${table})`)
          .all()
          .map(({ table: target, from, to, on_delete }) => ({
            table: target,
            from,
            to,
            on_delete,
          }))
          .sort((left, right) => left.table.localeCompare(right.table)),
      ),
      versionColumns: db
        .prepare("PRAGMA table_info(item_versions)")
        .all()
        .map(({ name, notnull }) => ({ name, notnull })),
      observationColumns: db
        .prepare("PRAGMA table_info(collection_items)")
        .all()
        .map(({ name, notnull }) => ({ name, notnull })),
      versionIndexes: db.prepare("PRAGMA index_list(item_versions)").all(),
      observationIndexes: db.prepare("PRAGMA index_list(collection_items)").all(),
      fts: db.prepare("SELECT sql FROM sqlite_schema WHERE name='library_fts'").get().sql,
      ftsColumns: db
        .prepare("PRAGMA table_info(library_fts)")
        .all()
        .map((row) => row.name),
      ftsRows: db.prepare("SELECT * FROM library_fts").all(),
      migrationTables: db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('item_versions_v1','item_versions_v2','collection_items_v1','collection_items_v2')",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}

function assertLegacyRowsPreserved(state, { payload, hash }, { schemaVersion = 2 } = {}) {
  assert.equal(state.item.id, itemId);
  assert.equal(state.item.latest_version_id, versionId);
  assert.equal(state.item.source, legacyItem.sourceId);
  assert.equal(state.item.external_id, legacyItem.externalId);
  assert.equal(state.item.url, legacyItem.url);
  assert.equal(state.item.first_seen, priorTime);
  assert.equal(state.item.last_seen, time);
  assert.deepEqual(
    state.versionRows,
    [
      {
        id: versionId,
        item_id: itemId,
        hash,
        payload,
        title: legacyItem.title,
        body: legacyItem.text,
      },
      {
        id: priorVersionId,
        item_id: itemId,
        hash: versionHash(priorItem),
        payload: JSON.stringify(priorItem),
        title: priorItem.title,
        body: priorItem.text,
      },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  );
  assert.deepEqual(
    state.observations,
    [
      {
        run_id: runId,
        item_id: itemId,
        version_id: versionId,
        discovered_at: time,
        retrieved_at: time,
        position: legacyItem.observedPosition,
      },
      {
        run_id: priorRunId,
        item_id: itemId,
        version_id: priorVersionId,
        discovered_at: priorTime,
        retrieved_at: priorTime,
        position: priorItem.observedPosition,
      },
    ].sort((left, right) => left.run_id.localeCompare(right.run_id)),
  );
  assert.deepEqual(state.foreignKeys, [
    [{ table: "items", from: "item_id", to: "id", on_delete: "CASCADE" }],
    [
      { table: "collection_runs", from: "run_id", to: "id", on_delete: "CASCADE" },
      { table: "item_versions", from: "version_id", to: "id", on_delete: "CASCADE" },
      { table: "items", from: "item_id", to: "id", on_delete: "CASCADE" },
    ],
  ]);
  assert.deepEqual(state.foreignKeyErrors, []);
  assert.equal(
    state.versionColumns.find((column) => column.name === "body").notnull,
    schemaVersion === 1 ? 1 : 0,
  );
  assert.equal(
    state.observationColumns.find((column) => column.name === "retrieved_at").notnull,
    schemaVersion === 1 ? 1 : 0,
  );
  assert.ok(state.versionIndexes.some((index) => index.name === "versions_by_item"));
  assert.ok(state.observationIndexes.some((index) => index.name === "observations_by_item"));
}

test("reading a v1 library migrates it without changing saved identities or evidence", async (t) => {
  const fixture = await seedLegacyDatabase(t);
  const library = new SQLiteContentLibrary(fixture.root);
  t.after(() => library.close());

  const item = await library.read({ itemId });
  assert.equal(item.itemId, itemId);
  assert.equal(item.versionId, versionId);
  assert.equal(item.text, legacyItem.text);
  assert.equal(item.summary, legacyItem.summary);

  const migrated = snapshot(fixture.path);
  assert.equal(migrated.version, 2);
  assertLegacyRowsPreserved(migrated, fixture);
  assert.deepEqual(migrated.ftsColumns, ["title", "summary", "body", "version_id"]);
  assert.equal(migrated.ftsRows.length, 2);
  const indexedLatest = migrated.ftsRows.find((row) => row.version_id === versionId);
  const indexedEarlier = migrated.ftsRows.find((row) => row.version_id === priorVersionId);
  assert.equal(indexedLatest.summary, legacyItem.summary.toLowerCase());
  assert.equal(indexedLatest.body, legacyItem.text.toLowerCase());
  assert.equal(indexedEarlier.summary, priorItem.summary.toLowerCase());
  assert.equal(indexedEarlier.body, priorItem.text.toLowerCase());
  assert.deepEqual(migrated.migrationTables, []);
});

test("searching a v1 library migrates summary search and repeated content keeps its version", async (t) => {
  const fixture = await seedLegacyDatabase(t);
  const library = new SQLiteContentLibrary(fixture.root);
  t.after(() => library.close());

  const matches = await library.search({ query: "migration summary ä phrase" });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].itemId, itemId);
  assert.equal(matches[0].versionId, versionId);
  assert.equal(matches[0].text, legacyItem.text);
  assert.equal(snapshot(fixture.path).version, 2);

  const saved = await library.save({
    batch: {
      id: randomUUID(),
      sourceId: legacyItem.sourceId,
      collectedAt: time,
      items: [{ ...legacyItem }],
      failures: [],
      stopReason: "complete",
    },
    requestedCount: 1,
    startedAt: time,
  });
  assert.equal(saved.items[0].itemId, itemId);
  assert.equal(saved.items[0].versionId, versionId);
  const db = new DatabaseSync(fixture.path);
  try {
    assert.equal(db.prepare("SELECT count(*) AS count FROM item_versions").get().count, 2);
    assert.equal(db.prepare("SELECT count(*) AS count FROM library_fts").get().count, 2);
  } finally {
    db.close();
  }
});

test("an incompatible v1 schema is rejected atomically", async (t) => {
  const fixture = await seedLegacyDatabase(t, { incompatibleFts: true });
  const before = snapshot(fixture.path);
  const library = new SQLiteContentLibrary(fixture.root);
  t.after(() => library.close());

  await assert.rejects(library.search({ query: "legacy" }), /LIBRARY_SCHEMA/);

  const after = snapshot(fixture.path);
  assert.equal(after.version, 1);
  assertLegacyRowsPreserved(after, fixture, { schemaVersion: 1 });
  assert.equal(after.fts, before.fts);
  assert.deepEqual(after.ftsRows, before.ftsRows);
  assert.deepEqual(after.migrationTables, []);
});

test("a v1 payload error during FTS rebuild rolls back the started migration", async (t) => {
  const fixture = await seedLegacyDatabase(t, { malformedPayload: true });
  const before = snapshot(fixture.path);
  const library = new SQLiteContentLibrary(fixture.root);
  t.after(() => library.close());

  await assert.rejects(library.read({ itemId }), /LIBRARY_SCHEMA/);

  const after = snapshot(fixture.path);
  assert.equal(after.version, 1);
  assertLegacyRowsPreserved(after, fixture, { schemaVersion: 1 });
  assert.equal(after.fts, before.fts);
  assert.deepEqual(after.ftsColumns, before.ftsColumns);
  assert.deepEqual(after.ftsRows, before.ftsRows);
  assert.deepEqual(after.migrationTables, []);
});
