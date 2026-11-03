import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, wrapRegisteredTools } from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { registerSources } from "../../src/pi/sources.ts";
import { SourceRegistry } from "../../src/sources/registry.ts";
import { createSearchHarness } from "../helpers/search-harness.mjs";

const discoveredAt = "2026-01-02T03:04:05.000Z";
const itemId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";

function candidate(overrides = {}) {
  return {
    sourceId: "sample",
    externalId: "candidate-1",
    url: "https://example.com/candidate",
    title: "A discovered article",
    discoveredAt,
    itemId,
    versionId,
    ...overrides,
  };
}

async function piLibraryHarness(t, value) {
  const h = await createSearchHarness(t);
  const root = join(h.root, "library-cards");
  const registry = new SourceRegistry({ root });
  const entries = [];
  const runtime = h.loader.getExtensions().runtime;
  const appendEntry = runtime.appendEntry;
  runtime.appendEntry = (name, data) => entries.push({ name, data });
  const library = {
    async save() {
      throw new Error("Unexpected save in read-only library-card test");
    },
    async latest() {
      return undefined;
    },
    async search() {
      return [value];
    },
    async read() {
      return value;
    },
    async remove() {
      return false;
    },
    async close() {},
  };
  const extension = await loadExtensionFromFactory(
    (pi) => registerSources(pi, { root, registry, library }),
    h.cwd,
    createEventBus(),
    runtime,
  );
  const tools = wrapRegisteredTools([...extension.tools.values()], h.runner);
  t.after(async () => {
    runtime.appendEntry = appendEntry;
    await Promise.allSettled([registry.close(), library.close()]);
  });
  return { extension, entries, tools };
}

function render(extension, entry) {
  const renderer = extension.entryRenderers.get(entry.name);
  assert.ok(renderer, "Pi registered the local library card renderer");
  const theme = { bg: (_color, text) => text, fg: (_color, text) => text };
  return renderer(entry, { expanded: true }, theme).render(100).join("\n");
}

test("real Pi library search displays a stored candidate as link and source summary only", async (t) => {
  const summary = "A short source-provided summary.";
  const value = candidate({ summary });
  for (const field of ["text", "retrievedAt", "sourceCompleteness", "truncated"])
    assert.equal(field in value, false, `candidate fixture has no ${field}`);

  const { extension, entries, tools } = await piLibraryHarness(t, value);
  const tool = tools.find((entry) => entry.name === "current_library_search");
  assert.ok(tool, "Pi wraps the offline library search tool");
  const result = await tool.execute("candidate-search", { query: "article", limit: 10 });

  assert.deepEqual(result.structuredContent.references, [{ itemId, versionId }]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /A discovered article|source-provided summary|PRIVATE_BODY/,
  );
  const entry = entries.find((value) => value.data.title === "A discovered article");
  assert.ok(entry, "candidate result was appended as a local Pi card");
  assert.match(entry.data.body, /https:\/\/example\.com\/candidate/);
  assert.match(entry.data.body, /Discovered: 2026-01-02T03:04:05\.000Z/);
  assert.match(entry.data.body, /Summary only; no article body is stored\./);
  assert.match(entry.data.body, /Source summary: A short source-provided summary\./);
  assert.doesNotMatch(
    entry.data.body,
    /Retrieved:|Body preview:|completeness|truncated|No preview text/,
  );
  assert.match(render(extension, entry), /A short source-provided summary\./);
  assert.doesNotMatch(render(extension, entry), /PRIVATE_BODY|Retrieved:|Body preview:/);
});

test("real Pi library read shows a link-only candidate without body metadata or preview", async (t) => {
  const value = candidate({ title: "Link-only article" });
  const { extension, entries, tools } = await piLibraryHarness(t, value);
  const tool = tools.find((entry) => entry.name === "current_library_read");
  assert.ok(tool, "Pi wraps the offline library read tool");
  const result = await tool.execute("candidate-read", { itemId });

  assert.deepEqual(result.structuredContent.references, [{ itemId, versionId }]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /Link-only article|https:\/\/example\.com\/candidate/,
  );
  const entry = entries.find((value) => value.data.title === "Link-only article");
  assert.ok(entry, "candidate result was appended as a local Pi card");
  assert.match(entry.data.body, /https:\/\/example\.com\/candidate/);
  assert.match(entry.data.body, /Discovered: 2026-01-02T03:04:05\.000Z/);
  assert.match(entry.data.body, /Link only\./);
  assert.doesNotMatch(
    entry.data.body,
    /Retrieved:|Body preview:|completeness|truncated|No preview text/,
  );
  assert.match(render(extension, entry), /Link only\./);
});
