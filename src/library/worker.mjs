import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { initialize } from "./schema.mjs";
import { answer, id, saveRequest, searchRequest, readRequest } from "./validation.mjs";

/** @param {unknown} value */
function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** @param {string} path */
function exists(path) {
  try {
    return lstatSync(path);
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return undefined;
    throw e;
  }
}
/** Refuse redirected paths and repository/vault ancestors, including symlinked parents.
 * @param {string} root */
function safePath(root) {
  if (!isAbsolute(root)) throw new Error("LIBRARY_PATH");
  let base = resolve(root);
  const missing = [];
  while (!exists(base)) {
    missing.unshift(base.slice(dirname(base).length + 1));
    base = dirname(base);
  }
  let canonical;
  try {
    canonical = resolve(realpathSync(base), ...missing);
  } catch {
    throw new Error("LIBRARY_PATH");
  }
  let cursor = canonical;
  while (true) {
    const entry = exists(cursor);
    if (entry && !entry.isDirectory()) throw new Error("LIBRARY_PATH");
    if (exists(join(cursor, ".git")) || exists(join(cursor, ".obsidian")))
      throw new Error("LIBRARY_PATH");
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const path = join(canonical, "content.sqlite");
  const entry = exists(path);
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error("LIBRARY_PATH");
  return path;
}
/** @param {Record<string, import('node:sqlite').SQLOutputValue>} row */
function item(row) {
  const value = JSON.parse(String(row.payload));
  answer(value);
  id(row.item_id);
  id(row.version_id);
  return { ...value, itemId: String(row.item_id), versionId: String(row.version_id) };
}
/** @param {import('node:sqlite').DatabaseSync} db @param {string} runId @returns {import('./types.ts').LibraryBatch | undefined} */
function batch(db, runId) {
  const run = db.prepare("SELECT * FROM collection_runs WHERE id=?").get(runId);
  if (!run) return undefined;
  const items = db
    .prepare(`SELECT v.payload, o.* FROM collection_items o JOIN item_versions v ON v.id=o.version_id
    WHERE o.run_id=? ORDER BY o.position,o.item_id`)
    .all(runId)
    .map((row) => ({
      ...item(row),
      discoveredAt: String(row.discovered_at),
      retrievedAt: String(row.retrieved_at),
      observedPosition: Number(row.position),
    }));
  return {
    id: runId,
    sourceId: String(run.source),
    collectedAt: String(run.completed_at),
    items,
    failures: JSON.parse(String(run.failures)),
    stopReason: String(run.stop_reason),
  };
}
/** @param {import('node:sqlite').DatabaseSync} db @param {import('./types.ts').SaveRequest} request */
function save(db, request) {
  const b = request.batch;
  const digest = hash(request);
  const previous = db.prepare("SELECT hash FROM collection_runs WHERE id=?").get(b.id);
  if (previous) {
    if (previous.hash !== digest) throw new Error("LIBRARY_CONFLICT");
    return batch(db, b.id);
  }
  db.prepare("INSERT INTO collection_runs VALUES (?,?,?,?,?,?,?,?,?)").run(
    b.id,
    b.sourceId,
    digest,
    request.requestedCount,
    request.startedAt,
    b.collectedAt,
    b.items.length,
    JSON.stringify(b.failures),
    b.stopReason,
  );
  for (const a of b.items) {
    const existing = db
      .prepare("SELECT id FROM items WHERE source=? AND external_id=?")
      .get(a.sourceId, a.externalId);
    const itemId = existing ? String(existing.id) : randomUUID();
    if (!existing)
      db.prepare("INSERT INTO items VALUES (?,?,?,?,?,?,?)").run(
        itemId,
        a.sourceId,
        a.externalId,
        a.url,
        null,
        a.discoveredAt ?? a.retrievedAt,
        a.discoveredAt ?? a.retrievedAt,
      );
    const versionHash = hash([
      a.url,
      a.title,
      a.author ?? null,
      a.text,
      a.sourceCompleteness,
      a.truncated,
      a.metadata ?? null,
    ]);
    const version = db
      .prepare("SELECT id FROM item_versions WHERE item_id=? AND hash=?")
      .get(itemId, versionHash);
    const versionId = version ? String(version.id) : randomUUID();
    if (!version) {
      db.prepare("INSERT INTO item_versions VALUES (?,?,?,?,?,?)").run(
        versionId,
        itemId,
        versionHash,
        JSON.stringify(a),
        a.title,
        a.text,
      );
      db.prepare("INSERT INTO library_fts(title,body,version_id) VALUES (?,?,?)").run(
        a.title.toLowerCase(),
        a.text.toLowerCase(),
        versionId,
      );
    }
    db.prepare("UPDATE items SET latest_version_id=?,last_seen=?,url=? WHERE id=?").run(
      versionId,
      a.discoveredAt ?? a.retrievedAt,
      a.url,
      itemId,
    );
    db.prepare("INSERT INTO collection_items VALUES (?,?,?,?,?,?)").run(
      b.id,
      itemId,
      versionId,
      a.discoveredAt ?? a.retrievedAt,
      a.retrievedAt,
      a.observedPosition ?? 1,
    );
  }
  return batch(db, b.id);
}
/** @param {import('node:sqlite').DatabaseSync} db @param {import('./types.ts').SearchRequest} request */
function search(db, request) {
  const query = request.query.trim().toLowerCase();
  // Literal phrase semantics; user punctuation is never interpreted as FTS syntax.
  const long = [...query].length >= 3;
  const sql = `SELECT v.payload,v.id AS version_id,i.id AS item_id FROM library_fts f
    JOIN item_versions v ON v.id=f.version_id JOIN items i ON i.latest_version_id=v.id
    WHERE ${long ? "library_fts MATCH ? AND " : ""}(instr(f.title,?)>0 OR instr(f.body,?)>0) ${request.source ? "AND i.source=?" : ""}
    ORDER BY ${long ? "bm25(library_fts)," : ""}i.last_seen DESC,i.id LIMIT ?`;
  const params = [
    ...(long ? [`"${query.replaceAll('"', '""')}"`] : []),
    query,
    query,
    ...(request.source ? [request.source] : []),
    request.limit ?? 10,
  ];
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => {
      const value = item(row);
      const chars = [...value.text];
      const offset = Math.max(0, value.text.toLowerCase().indexOf(query) - 80);
      const start = [...value.text.slice(0, offset)].length;
      return {
        ...value,
        text: chars.slice(start, start + 400).join(""),
        displayTruncated: chars.length > 400,
      };
    });
}
/** @param {import('node:sqlite').DatabaseSync} db @param {import('./types.ts').ReadRequest} request */
function read(db, request) {
  const row = db
    .prepare(`SELECT v.payload,v.id AS version_id,i.id AS item_id FROM items i JOIN item_versions v
    ON v.item_id=i.id WHERE i.id=? AND v.id=${request.versionId ? "?" : "i.latest_version_id"}`)
    .get(...(request.versionId ? [request.itemId, request.versionId] : [request.itemId]));
  if (!row) return undefined;
  const value = item(row);
  const chars = [...value.text];
  const max = request.maxCharacters ?? 20000;
  return { ...value, text: chars.slice(0, max).join(""), displayTruncated: chars.length > max };
}
/** @param {import('node:sqlite').DatabaseSync} db @param {string} itemId */
function remove(db, itemId) {
  db.prepare(
    "DELETE FROM library_fts WHERE version_id IN (SELECT id FROM item_versions WHERE item_id=?)",
  ).run(itemId);
  return db.prepare("DELETE FROM items WHERE id=?").run(itemId).changes > 0;
}
/** @param {unknown} error */
function code(error) {
  const message = error instanceof Error ? error.message : "";
  if (/^LIBRARY_[A-Z_]+$/.test(message)) return message;
  if (/locked|busy/i.test(message)) return "LIBRARY_BUSY";
  return "LIBRARY_STORAGE_ERROR";
}

/** IPC is a private parent/child boundary. Requests are validated before opening SQLite.
 * @param {{ root: string; operation: string; request: unknown }} workerData */
function execute(workerData) {
  let db;
  try {
    const { root, operation, request } = workerData;
    if (operation === "save") saveRequest(request);
    else if (operation === "search") searchRequest(request);
    else if (operation === "read") readRequest(request);
    else if (operation === "remove") id(request);
    else if (operation === "latest") {
      if (
        request !== undefined &&
        (typeof request !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(request))
      )
        throw new Error("LIBRARY_INVALID");
    } else throw new Error("LIBRARY_INVALID");
    const path = safePath(root);
    const writing = operation === "save" || operation === "remove";
    let result;
    if (!exists(path) && operation !== "save")
      result = operation === "search" ? [] : operation === "remove" ? false : undefined;
    else {
      if (!exists(path)) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        if (safePath(root) !== path) throw new Error("LIBRARY_PATH");
        try {
          closeSync(openSync(path, "wx", 0o600));
        } catch (e) {
          if (!e || typeof e !== "object" || !("code" in e) || e.code !== "EEXIST") throw e;
        }
      }
      if (safePath(root) !== path) throw new Error("LIBRARY_PATH");
      for (const suffix of ["-journal", "-wal", "-shm"]) {
        const sidecar = exists(path + suffix);
        if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink()))
          throw new Error("LIBRARY_PATH");
      }
      db = new DatabaseSync(path, {
        readOnly: !writing && !exists(`${path}-journal`),
        timeout: 1000,
        enableForeignKeyConstraints: true,
        allowExtension: false,
      });
      if (writing) db.exec("PRAGMA synchronous=FULL");
      db.exec(writing ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED");
      const ready = initialize(db, operation === "save");
      if (!ready) result = operation === "search" ? [] : operation === "remove" ? false : undefined;
      else if (operation === "save") {
        saveRequest(request);
        result = save(db, request);
      } else if (operation === "search") {
        searchRequest(request);
        result = search(db, request);
      } else if (operation === "read") {
        readRequest(request);
        result = read(db, request);
      } else if (operation === "remove") {
        id(request);
        result = remove(db, request);
      } else {
        const last = db
          .prepare(`SELECT id FROM collection_runs r WHERE EXISTS (SELECT 1 FROM collection_items o WHERE o.run_id=r.id) ${request ? "AND r.source=?" : ""}
          ORDER BY completed_at DESC,rowid DESC LIMIT 1`)
          .get(...(typeof request === "string" ? [request] : []));
        result = last ? batch(db, String(last.id)) : undefined;
      }
      db.exec(ready ? "COMMIT" : "ROLLBACK");
    }
    db?.close();
    db = undefined;
    return { ok: true, result };
  } catch (error) {
    if (db?.isOpen) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
      } finally {
        db.close();
      }
    }
    return { ok: false, code: code(error) };
  }
}
process.once("message", (message) => {
  const result = execute(
    /** @type {{ root: string; operation: string; request: unknown }} */ (message),
  );
  process.send?.(result, () => process.exit(0));
});
