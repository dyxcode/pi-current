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

export const schema = `
CREATE TABLE items (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, url TEXT NOT NULL, latest_version_id TEXT,
 first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, UNIQUE(source, external_id)
) STRICT;
CREATE TABLE item_versions (
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
 hash TEXT NOT NULL, payload TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
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
 discovered_at TEXT NOT NULL, retrieved_at TEXT, position INTEGER NOT NULL,
 PRIMARY KEY(run_id, item_id)
) STRICT;
CREATE INDEX observations_by_item ON collection_items(item_id);
CREATE INDEX versions_by_item ON item_versions(item_id);
CREATE VIRTUAL TABLE library_fts USING fts5(title, summary, body, version_id UNINDEXED, tokenize='trigram');
PRAGMA user_version=2;
`;

const itemVersionsV2 = `
CREATE TABLE item_versions_v2 (
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
 hash TEXT NOT NULL, payload TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
 UNIQUE(item_id, hash)
) STRICT;
`;

const collectionItemsV2 = `
CREATE TABLE collection_items_v2 (
 run_id TEXT NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES item_versions_v2(id) ON DELETE CASCADE,
 discovered_at TEXT NOT NULL, retrieved_at TEXT, position INTEGER NOT NULL,
 PRIMARY KEY(run_id, item_id)
) STRICT;
`;

/** @param {import('node:sqlite').DatabaseSync} db @param {boolean} create */
export function initialize(db, create) {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  const hasObjects =
    db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().length > 0;
  if (version === 0 && !hasObjects) {
    if (!create) return false;
    db.exec(schema);
  } else if (version === 1) {
    validateSchema(db, schemaV1);
    migrateV1ToV2(db);
    db.exec("PRAGMA user_version=2");
  } else if (version !== 2) throw new Error("LIBRARY_SCHEMA");

  validateSchema(db, schema);
  return true;
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} definition */
function validateSchema(db, definition) {
  // Additional local objects are not repaired or removed.
  for (const statement of definition.split(";").map((sql) => sql.trim())) {
    const match = /^CREATE (?:VIRTUAL TABLE|TABLE|INDEX) (\w+)/.exec(statement);
    if (!match) continue;
    const stored = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(match[1] ?? "");
    if (typeof stored?.sql !== "string" || normalize(stored.sql) !== normalize(statement))
      throw new Error("LIBRARY_SCHEMA");
  }
}

/** @param {import('node:sqlite').DatabaseSync} db */
function migrateV1ToV2(db) {
  db.exec("DROP TABLE library_fts");
  db.exec("ALTER TABLE item_versions RENAME TO item_versions_v1");
  db.exec(itemVersionsV2);
  db.exec(`INSERT INTO item_versions_v2 (id,item_id,hash,payload,title,body)
    SELECT id,item_id,hash,payload,title,body FROM item_versions_v1`);
  db.exec("ALTER TABLE collection_items RENAME TO collection_items_v1");
  db.exec(collectionItemsV2);
  db.exec(`INSERT INTO collection_items_v2 (run_id,item_id,version_id,discovered_at,retrieved_at,position)
    SELECT run_id,item_id,version_id,discovered_at,retrieved_at,position FROM collection_items_v1`);
  db.exec("DROP TABLE collection_items_v1");
  db.exec("DROP TABLE item_versions_v1");
  db.exec("ALTER TABLE item_versions_v2 RENAME TO item_versions");
  db.exec("ALTER TABLE collection_items_v2 RENAME TO collection_items");
  db.exec("CREATE INDEX observations_by_item ON collection_items(item_id)");
  db.exec("CREATE INDEX versions_by_item ON item_versions(item_id)");
  db.exec(
    "CREATE VIRTUAL TABLE library_fts USING fts5(title, summary, body, version_id UNINDEXED, tokenize='trigram')",
  );

  const insert = db.prepare(
    "INSERT INTO library_fts(title,summary,body,version_id) VALUES (?,?,?,?)",
  );
  for (const row of db.prepare("SELECT id,title,payload,body FROM item_versions").iterate()) {
    let payload;
    try {
      payload = JSON.parse(String(row.payload));
    } catch {
      throw new Error("LIBRARY_SCHEMA");
    }
    const summary =
      payload && typeof payload === "object" && typeof payload.summary === "string"
        ? payload.summary
        : "";
    insert.run(
      String(row.title).toLowerCase(),
      summary.toLowerCase(),
      typeof row.body === "string" ? row.body.toLowerCase() : "",
      String(row.id),
    );
  }
}

/** @param {string} sql */
function normalize(sql) {
  return sql
    .replace(/\b(CREATE TABLE|REFERENCES)\s+"([^"]+)"/gi, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}
