import {
  MAX_ARTICLE_BYTES,
  MAX_BATCH_BYTES,
  MAX_SUMMARY_CHARACTERS,
} from "../sources/content-limits.mjs";

const SOURCE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_PREPARATION_ISSUE_CHARACTERS = 1000;
const MAX_FEED_VALIDATOR_CHARACTERS = 8192;

/** @param {unknown} value @returns {asserts value is Record<string, unknown>} */
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("LIBRARY_INVALID");
}
/** @param {unknown} value @returns {asserts value is string} */
function article(value) {
  if (
    typeof value !== "string" ||
    value.length > MAX_ARTICLE_BYTES ||
    Buffer.byteLength(value, "utf8") > MAX_ARTICLE_BYTES ||
    value.includes("\0") ||
    !value.trim()
  )
    throw new Error("LIBRARY_INVALID");
}
/** @param {unknown} value @param {number} max @param {boolean} [empty] @returns {asserts value is string} */
function text(value, max, empty = false) {
  if (typeof value !== "string" || value.includes("\0") || (!empty && !value.trim()))
    throw new Error("LIBRARY_INVALID");
  let characters = 0;
  for (const _character of value) {
    characters++;
    if (characters > max) throw new Error("LIBRARY_INVALID");
  }
}
/** @param {unknown} value @param {number} max */
function integer(value, max) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max)
    throw new Error("LIBRARY_INVALID");
}
/** @param {unknown} value */
function nonNegativeSafeInteger(value) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("LIBRARY_INVALID");
}
/** @param {string} address */
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
/** @param {unknown} value @returns {asserts value is string} */
export function sourceId(value) {
  text(value, 64);
  if (!SOURCE_ID.test(value)) throw new Error("LIBRARY_INVALID");
}
/** @param {unknown} value @returns {asserts value is import('../sources/types.ts').FeedValidators} */
export function feedValidators(value) {
  object(value);
  text(value.url, MAX_FEED_VALIDATOR_CHARACTERS);
  if (/[\r\n]/.test(value.url)) throw new Error("LIBRARY_INVALID");
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("LIBRARY_INVALID");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname ||
    url.href.length > MAX_FEED_VALIDATOR_CHARACTERS
  )
    throw new Error("LIBRARY_INVALID");
  for (const key of ["etag", "lastModified"]) {
    const header = value[key];
    if (header === undefined) continue;
    text(header, MAX_FEED_VALIDATOR_CHARACTERS);
    if (/[\r\n]/.test(header) || Buffer.byteLength(header, "utf8") > MAX_FEED_VALIDATOR_CHARACTERS)
      throw new Error("LIBRARY_INVALID");
  }
  if (Object.keys(value).some((key) => !["url", "etag", "lastModified"].includes(key)))
    throw new Error("LIBRARY_INVALID");
}
/** @param {unknown} value @returns {asserts value is import('./types.ts').LibraryContent} */
export function answer(value) {
  object(value);
  sourceId(value.sourceId);
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
  if (value.text !== undefined) {
    article(value.text);
    date(value.retrievedAt);
    if (
      !["unknown", "known-partial"].includes(String(value.sourceCompleteness)) ||
      typeof value.truncated !== "boolean"
    )
      throw new Error("LIBRARY_INVALID");
  } else {
    date(value.discoveredAt);
    if (
      value.retrievedAt !== undefined ||
      value.sourceCompleteness !== undefined ||
      value.truncated !== undefined
    )
      throw new Error("LIBRARY_INVALID");
  }
  if (value.summary !== undefined) text(value.summary, MAX_SUMMARY_CHARACTERS, true);
  if (value.discoveredAt !== undefined) date(value.discoveredAt);
  if (value.observedPosition !== undefined)
    integer(value.observedPosition, Number.MAX_SAFE_INTEGER);
  if (
    Object.keys(value).some(
      (k) =>
        ![
          "sourceId",
          "externalId",
          "url",
          "title",
          "author",
          "summary",
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
  nonNegativeSafeInteger(value.requestedCount);
  date(value.startedAt);
  const batch = value.batch;
  object(batch);
  id(batch.id);
  date(batch.collectedAt);
  text(batch.stopReason, 100);
  sourceId(batch.sourceId);
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
    size += Buffer.byteLength(item.text ?? "", "utf8");
    if (size > MAX_BATCH_BYTES) throw new Error("LIBRARY_INVALID");
  }
  for (const failure of batch.failures) {
    object(failure);
    text(failure.externalId, 256);
    text(failure.code, 100);
  }
}
/** @param {unknown} value @returns {asserts value is import('./types.ts').PreparationRequest} */
export function preparationRequest(value) {
  object(value);
  sourceId(value.sourceId);
  date(value.attemptedAt);
  if (!Array.isArray(value.issues)) throw new Error("LIBRARY_INVALID");
  for (const issue of value.issues) text(issue, MAX_PREPARATION_ISSUE_CHARACTERS);
  const hasValidators = Object.hasOwn(value, "validators");
  if (hasValidators) feedValidators(value.validators);
  const hasNotModified = Object.hasOwn(value, "notModified");
  if (hasNotModified) id(value.notModified);
  const hasSave = Object.hasOwn(value, "save");
  if (hasNotModified && hasSave) throw new Error("LIBRARY_INVALID");
  if (hasSave) {
    saveRequest(value.save);
    if (value.save.batch.sourceId !== value.sourceId) throw new Error("LIBRARY_INVALID");
  } else if (!hasNotModified && value.issues.length === 0) throw new Error("LIBRARY_INVALID");
  if (
    Object.keys(value).some(
      (key) =>
        !["sourceId", "attemptedAt", "issues", "save", "validators", "notModified"].includes(key),
    )
  )
    throw new Error("LIBRARY_INVALID");
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
  if (value.maxCharacters !== undefined) integer(value.maxCharacters, MAX_ARTICLE_BYTES);
  if (Object.keys(value).some((key) => !["itemId", "versionId", "maxCharacters"].includes(key)))
    throw new Error("LIBRARY_INVALID");
}
