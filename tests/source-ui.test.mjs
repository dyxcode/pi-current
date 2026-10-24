import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEventBus,
  wrapRegisteredTools,
  SessionManager,
  buildSessionContext,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { prepareCompaction } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { registerSources } from "../src/pi/sources.ts";
import { createSearchHarness } from "./helpers/search-harness.mjs";
import { sourceHarness, saveRequest } from "./helpers/source-harness.mjs";

test("/sources registers a local module without collecting; capability actions and removal retain storage", async (t) => {
  const f = await sourceHarness(t);
  const options = [];
  const choices = [
    "Add source",
    "Sample",
    "Log in",
    "Sample",
    "Disable",
    "Sample",
    "Remove source",
    "Back",
  ];
  await f.commands.get("sources").handler("", {
    hasUI: true,
    ui: {
      async select(_title, rows) {
        options.push(rows);
        const next = choices.shift();
        return next === "Sample" ? rows[0] : next;
      },
      async input() {
        return f.modulePath;
      },
      notify() {},
    },
  });
  assert.deepEqual(await f.registry.list(), []);
  assert.ok(!JSON.stringify(options).includes("Collect"));
  assert.ok(options.some((rows) => rows.includes("Enable")));
  assert.deepEqual(await f.library.search({ query: "PRIVATE" }), []);
});

test("one source-bound request permits one collection; recommendation, quoted and generated input do not", async (t) => {
  const f = await sourceHarness(t);
  await f.registry.register(f.modulePath);
  const tool = f.tools.get("current_feed_collect");
  for (const [text, source] of [
    ["Recommend something", "interactive"],
    ["> Collect 3 items from sample", "interactive"],
    ["Collect 3 items from sample", "extension"],
  ]) {
    await f.emit("input", { text, source });
    await assert.rejects(
      tool.execute("unrequested", { source: "sample", limit: 3 }),
      /COLLECTION_NOT_REQUESTED/,
    );
  }
  await f.emit("input", { text: "采集3个Sample文章", source: "interactive" });
  await assert.rejects(
    tool.execute("wrong-source", { source: "other", limit: 3 }),
    /COLLECTION_NOT_REQUESTED/,
  );
  await assert.rejects(
    tool.execute("too-many", { source: "sample", limit: 4 }),
    /COLLECTION_LIMIT/,
  );
  const result = await tool.execute("collect", { source: "sample", limit: 3 });
  assert.equal(result.structuredContent.count, 1);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  assert.match(JSON.stringify(f.entries), /PRIVATE_BODY/);
  await assert.rejects(
    tool.execute("repeat", { source: "sample", limit: 3 }),
    /COLLECTION_NOT_REQUESTED/,
  );
  await f.emit("input", { text: "Collect 1 item from sample", source: "interactive" });
  await f.emit("agent_end");
  await assert.rejects(
    tool.execute("after-end", { source: "sample", limit: 1 }),
    /COLLECTION_NOT_REQUESTED/,
  );
});

test("read permission binds exact URL and expires after one read; cached status exposes no file paths", async (t) => {
  const f = await sourceHarness(t);
  await f.registry.register(f.modulePath);
  await f.emit("input", { text: "Read https://example.com/a from Sample", source: "interactive" });
  await assert.rejects(f.api.read("https://example.com/b", 2000), /BROWSER_READ_NOT_REQUESTED/);
  const result = await f.api.read("https://example.com/a", 2000);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  await assert.rejects(f.api.read("https://example.com/a", 2000), /BROWSER_READ_NOT_REQUESTED/);
  const status = await f.tools.get("current_sources").execute("list", { action: "list" });
  assert.ok(!JSON.stringify(status).includes(f.root));
  await f.emit("input", { text: "Recommend something", source: "interactive" });
  for (const action of ["login", "check"]) {
    await assert.rejects(
      f.tools.get("current_sources").execute(action, { action, source: "sample" }),
      /SOURCE_ACTION_NOT_REQUESTED/,
    );
  }
});

test("real Pi wrapper validates generic tools and keeps evidence out of model context and compaction", async (t) => {
  const f = await sourceHarness(t);
  await f.registry.register(f.modulePath);
  const h = await createSearchHarness(t);
  assert.deepEqual([...h.extension.commands.keys()], ["sources"]);
  const extension = await loadExtensionFromFactory(
    (pi) => registerSources(pi, { root: f.data, registry: f.registry, library: f.library }),
    h.cwd,
    createEventBus(),
    h.loader.getExtensions().runtime,
  );
  const wrapped = wrapRegisteredTools([...extension.tools.values()], h.runner);
  await f.library.save(saveRequest());
  const result = await wrapped
    .find((tool) => tool.name === "current_library_search")
    .execute("search", { query: "PRIVATE" });
  assert.equal(result.structuredContent.count, 1);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));

  const session = SessionManager.inMemory();
  session.appendCustomEntry("pi-current-local-card", {
    title: "PRIVATE_TITLE",
    body: "PRIVATE_BODY",
  });
  session.appendMessage({
    role: "user",
    content: "ordinary message ".repeat(100),
    timestamp: Date.now(),
  });
  session.appendMessage({ role: "user", content: "another message", timestamp: Date.now() });
  session.appendModelChange("fixture", "fixture");
  assert.ok(
    !JSON.stringify(buildSessionContext(structuredClone(session.getEntries()))).includes(
      "PRIVATE_",
    ),
  );
  assert.ok(
    !JSON.stringify(
      prepareCompaction(session.getEntries(), {
        enabled: true,
        reserveTokens: 10,
        keepRecentTokens: 1,
      }),
    ).includes("PRIVATE_"),
  );
});
