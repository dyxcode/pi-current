export const schema = `
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
/** @param {import('node:sqlite').DatabaseSync} db @param {boolean} create */
export function initialize(db, create) {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (
    version === 0 &&
    db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().length === 0
  ) {
    if (!create) return false;
    db.exec(schema);
  } else if (version !== 1) throw new Error("LIBRARY_SCHEMA");
  // Check table constraints and FTS configuration as well as column names.
  // Additional local objects are not repaired or removed.
  for (const statement of schema.split(";").map((sql) => sql.trim())) {
    const match = /^CREATE (?:VIRTUAL TABLE|TABLE|INDEX) (\w+)/.exec(statement);
    if (!match) continue;
    const stored = db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(match[1] ?? "");
    if (typeof stored?.sql !== "string" || normalize(stored.sql) !== normalize(statement))
      throw new Error("LIBRARY_SCHEMA");
  }
  return true;
}
/** @param {string} sql */
function normalize(sql) {
  return sql.replace(/\s+/g, " ").trim();
}
