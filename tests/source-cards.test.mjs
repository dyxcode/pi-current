import assert from "node:assert/strict";
import { test } from "node:test";
import { registerLocalCards } from "../src/pi/cards.ts";

function cardFixture() {
  const entries = [];
  const renderers = new Map();
  const pi = {
    appendEntry: (name, data) => entries.push({ name, data }),
    registerEntryRenderer: (name, renderer) => renderers.set(name, renderer),
  };
  const cards = registerLocalCards(pi);
  const theme = { bg: (_color, text) => text, fg: (_color, text) => text };
  const rendered = (entry, expanded) =>
    renderers.get(entry.name)(entry, { expanded }, theme).render(100).join("\n");
  return { cards, entries, rendered };
}

const retrievedAt = "2026-01-02T03:04:05.000Z";
const sourceItem = (overrides = {}) => ({
  sourceId: "sample",
  externalId: "opaque-source-id",
  url: "https://example.com/article",
  title: "An article title",
  text: "Full source body",
  retrievedAt,
  sourceCompleteness: "unknown",
  truncated: false,
  ...overrides,
});

const excerptFor = (body, label) => {
  const line = body.split("\n").find((value) => value.startsWith(`${label}: `));
  assert.ok(line, `expected a ${label} line in ${body}`);
  return line.slice(label.length + 2);
};

test("item cards prefer a bounded source summary and keep the full body out of both render states", () => {
  const { cards, entries, rendered } = cardFixture();
  const item = sourceItem({
    summary: `${"s".repeat(198)}😀tail`,
    text: `PRIVATE_BODY_HEAD ${"private article tail ".repeat(300)}`,
  });
  const original = structuredClone(item);

  cards.itemCard(item);

  const entry = entries[0];
  assert.equal(entry.data.title, item.title);
  assert.match(entry.data.body, /https:\/\/example\.com\/article/);
  assert.match(entry.data.body, /Source: sample/);
  assert.match(entry.data.body, /Retrieved: 2026-01-02/);
  const excerpt = excerptFor(entry.data.body, "Source summary");
  assert.equal(Array.from(excerpt).length, 200);
  assert.ok(excerpt.startsWith("s".repeat(198)));
  assert.ok(excerpt.endsWith("😀…"));
  assert.doesNotMatch(entry.data.body, /PRIVATE_BODY_HEAD|private article tail/);
  assert.doesNotMatch(rendered(entry, false), /PRIVATE_BODY_HEAD|private article tail/);
  assert.doesNotMatch(rendered(entry, true), /PRIVATE_BODY_HEAD|private article tail/);
  assert.deepEqual(item, original);
});

test("blank summaries fall back to a 200-codepoint body preview with Unicode-safe truncation", () => {
  const { cards, entries } = cardFixture();
  const item = sourceItem({
    summary: " \n\t ",
    text: `\u001b[31m${"a".repeat(194)}😀tail${"x".repeat(30)}`,
  });

  cards.itemCard(item);

  const body = entries[0].data.body;
  const excerpt = excerptFor(body, "Body preview");
  assert.equal(Array.from(excerpt).length, 200);
  assert.ok(excerpt.startsWith("a".repeat(194)));
  assert.ok(excerpt.endsWith("…"));
  assert.ok(excerpt.includes("😀"));
  assert.doesNotMatch(body, /Source summary:/);
  assert.equal(body.includes("\u001b"), false);
});

test("discovery cards cap source summaries and retain source link and discovery provenance", () => {
  const { cards, entries } = cardFixture();
  const summary = `${"topic ".repeat(50)}tail`;

  cards.discoveryCard({
    sourceId: "sample",
    externalId: "discovery-1",
    url: "https://example.com/discovered",
    title: "Discovered title",
    summary,
    contentType: "article",
    discoveredAt: retrievedAt,
    observedPosition: 2,
  });

  const body = entries[0].data.body;
  assert.match(body, /https:\/\/example\.com\/discovered/);
  assert.match(body, /Discovered: 2026-01-02/);
  assert.match(body, /Source summary:/);
  assert.equal(Array.from(excerptFor(body, "Source summary")).length, 200);
  assert.ok(excerptFor(body, "Source summary").endsWith("…"));
  assert.doesNotMatch(body, /topic .*tail/);
});

test("title-only items render a useful card without an empty preview", () => {
  const { cards, entries, rendered } = cardFixture();

  cards.itemCard(sourceItem({ text: "", summary: " \t " }));

  const entry = entries[0];
  assert.equal(entry.data.title, "An article title");
  assert.match(entry.data.body, /https:\/\/example\.com\/article/);
  assert.match(entry.data.body, /No preview text available\./);
  assert.match(rendered(entry, true), /An article title/);
});

test("known partial and locally truncated content stays clearly identified", () => {
  const { cards, entries } = cardFixture();

  cards.itemCard(
    sourceItem({
      sourceCompleteness: "known-partial",
      truncated: true,
      displayTruncated: true,
      text: "partial body",
    }),
  );

  const body = entries[0].data.body;
  assert.match(body, /known to be partial/i);
  assert.match(body, /returned content is marked truncated/i);
  assert.match(body, /display excerpt only/i);
});

test("status cards retain their existing cached-status content", () => {
  const { cards, entries } = cardFixture();

  cards.statusCard({
    id: "sample",
    name: "Sample",
    enabled: true,
    auth: "ready",
    checkedAt: retrievedAt,
    operations: [{ id: "read", name: "Read", kind: "read", connection: "main" }],
  });

  assert.equal(
    entries[0].data.body,
    "Last checked: 2026-01-02T03:04:05.000Z. Cached status, not a live guarantee.\n\nread: Read (read)\nManage this source in /sources. Login and checking never collect or resume work.",
  );
});
