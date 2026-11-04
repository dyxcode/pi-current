import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initialize } from "./schema.mjs";
import {
  answer,
  feedValidators,
  id,
  preparationRequest,
  readRequest,
  saveRequest,
  searchRequest,
  sourceId,
} from "./validation.mjs";

/** @param {unknown} value */
function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** @param {string} value @param {number} offset */
function characterOffset(value, offset) {
  let codeUnits = 0;
  let characters = 0;
  for (const character of value) {
    if (codeUnits >= offset) break;
    codeUnits += character.length;
    characters++;
  }
  return characters;
}
/** @param {string} value @param {number} start @param {number} max */
function characterSlice(value, start, max) {
  let characterIndex = 0;
  let codeUnits = 0;
  let sliceStart = start === 0 ? 0 : undefined;
  for (const character of value) {
    if (characterIndex === start && sliceStart === undefined) sliceStart = codeUnits;
    if (characterIndex === start + max)
      return {
        text: value.slice(sliceStart ?? codeUnits, codeUnits),
        displayTruncated: true,
      };
    codeUnits += character.length;
    characterIndex++;
  }
  return {
    text: value.slice(sliceStart ?? codeUnits, codeUnits),
    displayTruncated: start > 0,
  };
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
    .map((row) => {
      const value = item(row);
      const observation = {
        discoveredAt: String(row.discovered_at),
        observedPosition: Number(row.position),
      };
      return value.text === undefined
        ? { ...value, ...observation }
        : { ...value, ...observation, retrievedAt: String(row.retrieved_at) };
    });
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
  for (const input of b.items) {
    const existing = db
      .prepare(`SELECT i.id,v.payload FROM items i LEFT JOIN item_versions v ON v.id=i.latest_version_id
        WHERE i.source=? AND i.external_id=?`)
      .get(input.sourceId, input.externalId);
    const itemId = existing ? String(existing.id) : randomUUID();
    let a = input;
    if (existing?.payload) {
      const prior = JSON.parse(String(existing.payload));
      answer(prior);
      if (a.text === undefined && prior.text !== undefined) {
        a = {
          ...a,
          text: prior.text,
          retrievedAt: prior.retrievedAt,
          sourceCompleteness: prior.sourceCompleteness,
          truncated: prior.truncated,
        };
      }
      if (a.summary === undefined && prior.summary !== undefined)
        a = { ...a, summary: prior.summary };
    }
    const observedAt =
      input.text === undefined ? input.discoveredAt : (input.discoveredAt ?? input.retrievedAt);
    if (!existing)
      db.prepare("INSERT INTO items VALUES (?,?,?,?,?,?,?)").run(
        itemId,
        a.sourceId,
        a.externalId,
        a.url,
        null,
        observedAt,
        observedAt,
      );
    const versionHash = hash([
      a.url,
      a.title,
      a.author ?? null,
      a.text,
      a.sourceCompleteness,
      a.truncated,
      a.metadata ?? null,
      ...(a.summary === undefined ? [] : [a.summary]),
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
        a.text ?? null,
      );
      db.prepare("INSERT INTO library_fts(title,summary,body,version_id) VALUES (?,?,?,?)").run(
        a.title.toLowerCase(),
        (a.summary ?? "").toLowerCase(),
        (a.text ?? "").toLowerCase(),
        versionId,
      );
    }
    db.prepare("UPDATE items SET latest_version_id=?,last_seen=?,url=? WHERE id=?").run(
      versionId,
      observedAt,
      a.url,
      itemId,
    );
    db.prepare("INSERT INTO collection_items VALUES (?,?,?,?,?,?)").run(
      b.id,
      itemId,
      versionId,
      observedAt,
      a.retrievedAt ?? null,
      a.observedPosition ?? 1,
    );
  }
  return batch(db, b.id);
}
/** @param {import('node:sqlite').DatabaseSync} db @param {string} source */
function prepared(db, source) {
  const row = db.prepare("SELECT * FROM source_preparations WHERE source=?").get(source);
  if (!row) return undefined;
  let issues;
  try {
    issues = JSON.parse(String(row.issues));
  } catch {
    throw new Error("LIBRARY_SCHEMA");
  }
  if (!Array.isArray(issues) || issues.some((issue) => typeof issue !== "string"))
    throw new Error("LIBRARY_SCHEMA");
  const result = /** @type {import('./types.ts').PreparedSource} */ ({
    sourceId: String(row.source),
    attemptedAt: String(row.attempted_at),
    issues,
  });
  if (row.validators !== null) {
    try {
      result.validators = JSON.parse(String(row.validators));
      feedValidators(result.validators);
    } catch {
      throw new Error("LIBRARY_SCHEMA");
    }
  }
  if (row.run_id !== null) {
    const snapshot = batch(db, String(row.run_id));
    if (!snapshot) throw new Error("LIBRARY_SCHEMA");
    result.batch = snapshot;
  }
  return result;
}
/** @param {import('node:sqlite').DatabaseSync} db @param {import('./types.ts').PreparationRequest} request */
function prepare(db, request) {
  const previous = db
    .prepare("SELECT attempted_at,run_id,validators FROM source_preparations WHERE source=?")
    .get(request.sourceId);
  if (request.notModified !== undefined) {
    if (!previous || previous.run_id === null || !batch(db, String(previous.run_id)))
      throw new Error("LIBRARY_INVALID");
    if (previous.run_id !== request.notModified) {
      const current = prepared(db, request.sourceId);
      if (!current) throw new Error("LIBRARY_SCHEMA");
      return current;
    }
  }
  if (previous) {
    const previousTime = Date.parse(String(previous.attempted_at));
    if (!Number.isFinite(previousTime)) throw new Error("LIBRARY_SCHEMA");
    if (Date.parse(request.attemptedAt) < previousTime) {
      const current = prepared(db, request.sourceId);
      if (!current) throw new Error("LIBRARY_SCHEMA");
      return current;
    }
  }
  let runId = previous?.run_id ?? null;
  let validatorsJson = previous?.validators ?? null;
  if (request.save) {
    const snapshot = save(db, request.save);
    if (!snapshot) throw new Error("LIBRARY_SCHEMA");
    runId = snapshot.id;
    validatorsJson = request.validators ? JSON.stringify(request.validators) : null;
  } else if (request.notModified !== undefined && request.validators) {
    validatorsJson = JSON.stringify(request.validators);
  }
  db.prepare(`INSERT INTO source_preparations (source,attempted_at,issues,validators,run_id) VALUES (?,?,?,?,?)
    ON CONFLICT(source) DO UPDATE SET attempted_at=excluded.attempted_at, issues=excluded.issues,
    validators=excluded.validators, run_id=excluded.run_id`).run(
    request.sourceId,
    request.attemptedAt,
    JSON.stringify(request.issues),
    validatorsJson,
    runId,
  );
  const result = prepared(db, request.sourceId);
  if (!result) throw new Error("LIBRARY_SCHEMA");
  return result;
}
/** @param {import('node:sqlite').DatabaseSync} db @param {import('./types.ts').SearchRequest} request */
function search(db, request) {
  const query = request.query.trim().toLowerCase();
  // Literal phrase semantics; user punctuation is never interpreted as FTS syntax.
  const long = [...query].length >= 3;
  const sql = `SELECT v.payload,v.id AS version_id,i.id AS item_id FROM library_fts f
    JOIN item_versions v ON v.id=f.version_id JOIN items i ON i.latest_version_id=v.id
    WHERE ${long ? "library_fts MATCH ? AND " : ""}(instr(f.title,?)>0 OR instr(f.summary,?)>0 OR instr(f.body,?)>0) ${request.source ? "AND i.source=?" : ""}
    ORDER BY ${long ? "bm25(library_fts)," : ""}i.last_seen DESC,i.id LIMIT ?`;
  const params = [
    ...(long ? [`"${query.replaceAll('"', '""')}"`] : []),
    query,
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
      if (value.text === undefined) return value;
      const match = value.text.toLowerCase().indexOf(query);
      const start = Math.max(0, characterOffset(value.text, Math.max(0, match)) - 80);
      const excerpt = characterSlice(value.text, start, 400);
      return {
        ...value,
        text: excerpt.text,
        displayTruncated: excerpt.displayTruncated,
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
  if (value.text === undefined) return value;
  const max = request.maxCharacters ?? 20000;
  const excerpt = characterSlice(value.text, 0, max);
  return { ...value, text: excerpt.text, displayTruncated: excerpt.displayTruncated };
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
    else if (operation === "prepare") preparationRequest(request);
    else if (operation === "prepared") sourceId(request);
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
    const preparation = /** @type {import('./types.ts').PreparationRequest | undefined} */ (
      operation === "prepare" ? request : undefined
    );
    if (preparation?.notModified !== undefined && !exists(path)) throw new Error("LIBRARY_INVALID");
    const writing = operation === "save" || operation === "prepare" || operation === "remove";
    let result;
    if (!exists(path) && operation !== "save" && operation !== "prepare")
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
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      const migrating = version === 1 || version === 2;
      if (migrating) process.send?.({ phase: "migration" });
      if (migrating && !writing) {
        db.close();
        db = new DatabaseSync(path, {
          timeout: 1000,
          enableForeignKeyConstraints: true,
          allowExtension: false,
        });
      }
      if (writing || migrating) db.exec("PRAGMA synchronous=FULL");
      db.exec(writing || migrating ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED");
      const ready = initialize(db, operation === "save" || operation === "prepare");
      if (migrating) process.send?.({ phase: "operation" });
      if (!ready) result = operation === "search" ? [] : operation === "remove" ? false : undefined;
      else if (operation === "save") {
        saveRequest(request);
        result = save(db, request);
      } else if (operation === "prepare") {
        preparationRequest(request);
        result = prepare(db, request);
      } else if (operation === "prepared") {
        sourceId(request);
        result = prepared(db, request);
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
