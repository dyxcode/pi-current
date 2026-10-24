/** @param {unknown} value @returns {asserts value is Record<string, unknown>} */
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("LIBRARY_INVALID");
}
/** @param {unknown} value @param {number} max @param {boolean} [empty] @returns {asserts value is string} */
function text(value, max, empty = false) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    (!empty && !value.trim()) ||
    [...value].length > max
  )
    throw new Error("LIBRARY_INVALID");
}
/** @param {unknown} value @param {number} max */
function integer(value, max) {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max)
    throw new Error("LIBRARY_INVALID");
}
/** @param {unknown} value */
function date(value) {
  text(value, 40);
  if (!Number.isFinite(Date.parse(value))) throw new Error("LIBRARY_INVALID");
}
/** @param {unknown} value @returns {asserts value is string} */
export function id(value) {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  )
    throw new Error("LIBRARY_INVALID");
}
/** @param {unknown} value @returns {asserts value is import('../sources/types.ts').SourceItem} */
export function answer(value) {
  object(value);
  text(value.sourceId, 64);
  if (!/^[a-z][a-z0-9-]*$/.test(value.sourceId)) throw new Error("LIBRARY_INVALID");
  text(value.externalId, 256);
  text(value.url, 8192);
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("LIBRARY_INVALID");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("LIBRARY_INVALID");
  text(value.title, 2000, true);
  if (value.author !== undefined) text(value.author, 1000, true);
  text(value.text, 5000);
  date(value.retrievedAt);
  if (value.discoveredAt !== undefined) date(value.discoveredAt);
  if (value.observedPosition !== undefined) integer(value.observedPosition, 10000);
  if (
    !["unknown", "known-partial"].includes(String(value.sourceCompleteness)) ||
    typeof value.truncated !== "boolean"
  )
    throw new Error("LIBRARY_INVALID");
  if (
    Object.keys(value).some(
      (k) =>
        ![
          "sourceId",
          "externalId",
          "url",
          "title",
          "author",
          "text",
          "retrievedAt",
          "discoveredAt",
          "observedPosition",
          "sourceCompleteness",
          "truncated",
          "metadata",
        ].includes(k),
    )
  )
    throw new Error("LIBRARY_INVALID");
  if (value.metadata !== undefined) {
    object(value.metadata);
    if (JSON.stringify(value.metadata).length > 4096) throw new Error("LIBRARY_INVALID");
    for (const [key, field] of Object.entries(value.metadata))
      if (
        !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) ||
        /cookie|token|secret|password|authorization/i.test(key) ||
        (field !== null && !["string", "number", "boolean"].includes(typeof field)) ||
        (typeof field === "number" && !Number.isFinite(field))
      )
        throw new Error("LIBRARY_INVALID");
  }
}
/** @param {unknown} value @returns {asserts value is import('./types.ts').SaveRequest} */
export function saveRequest(value) {
  object(value);
  integer(value.requestedCount, 10);
  date(value.startedAt);
  const batch = value.batch;
  object(batch);
  id(batch.id);
  date(batch.collectedAt);
  text(batch.stopReason, 100);
  text(batch.sourceId, 64);
  if (!/^[a-z][a-z0-9-]*$/.test(batch.sourceId)) throw new Error("LIBRARY_INVALID");
  if (
    !Array.isArray(batch.items) ||
    batch.items.length > Number(value.requestedCount) ||
    !Array.isArray(batch.failures) ||
    batch.failures.length > 1
  )
    throw new Error("LIBRARY_INVALID");
  const ids = new Set();
  let size = 0;
  for (const item of batch.items) {
    answer(item);
    if (ids.has(item.externalId) || item.sourceId !== batch.sourceId)
      throw new Error("LIBRARY_INVALID");
    ids.add(item.externalId);
    size += [...item.text].length;
  }
  if (size > 25000) throw new Error("LIBRARY_INVALID");
  for (const failure of batch.failures) {
    object(failure);
    text(failure.externalId, 256);
    text(failure.code, 100);
  }
}
/** @param {unknown} value @returns {asserts value is import('./types.ts').SearchRequest} */
export function searchRequest(value) {
  object(value);
  text(value.query, 200);
  if (value.limit !== undefined) integer(value.limit, 20);
  if (
    value.source !== undefined &&
    (typeof value.source !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.source))
  )
    throw new Error("LIBRARY_INVALID");
  if (Object.keys(value).some((key) => !["query", "source", "limit"].includes(key)))
    throw new Error("LIBRARY_INVALID");
}
/** @param {unknown} value @returns {asserts value is import('./types.ts').ReadRequest} */
export function readRequest(value) {
  object(value);
  id(value.itemId);
  if (value.versionId !== undefined) id(value.versionId);
  if (value.maxCharacters !== undefined) integer(value.maxCharacters, 20000);
  if (Object.keys(value).some((key) => !["itemId", "versionId", "maxCharacters"].includes(key)))
    throw new Error("LIBRARY_INVALID");
}
