import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceRegistry } from "../src/sources/registry.ts";
import {
  batch,
  deferred,
  item,
  memoryLibrary,
  row,
  saveRequest,
  sourceHarness,
  sourcePlugin,
} from "./helpers/source-harness.mjs";

const userInput = (text) => ({ text, source: "interactive" });

test("late source-name resolution cannot revive a grant after newer input or turn end", async (t) => {
  for (const invalidation of ["input", "agent_end", "session_shutdown", "session_start"]) {
    await t.test(invalidation, async (st) => {
      const pendingRows = deferred();
      const registry = { list: () => pendingRows.promise, async close() {} };
      const f = await sourceHarness(st, { registry });
      const pending = f.emit("input", userInput("Collect 1 item from Sample"));
      await f.emit(invalidation, invalidation === "input" ? userInput("Recommend something") : {});
      pendingRows.resolve([row()]);
      await pending;
      await assert.rejects(
        f.tools.get("current_feed_collect").execute("expired", { source: "sample", limit: 1 }),
        /COLLECTION_NOT_REQUESTED/,
      );
    });
  }
});

test("one collection grant cannot be consumed by two concurrent calls", async (t) => {
  const collecting = deferred();
  let calls = 0;
  const registry = {
    async list() {
      return [row()];
    },
    async close() {},
    async collect() {
      calls++;
      return collecting.promise;
    },
  };
  const f = await sourceHarness(t, { registry, library: memoryLibrary() });
  await f.emit("input", userInput("Collect 1 item from sample"));
  const first = f.tools
    .get("current_feed_collect")
    .execute("first", { source: "sample", limit: 1 });
  await assert.rejects(
    f.tools.get("current_feed_collect").execute("second", { source: "sample", limit: 1 }),
    /COLLECTION_NOT_REQUESTED/,
  );
  collecting.resolve(batch());
  assert.equal((await first).structuredContent.count, 1);
  assert.equal(calls, 1);
});

test("ambiguous source names and queued input never authorize collection", async (t) => {
  const registry = {
    async list() {
      return [row(), { ...row(), id: "other" }];
    },
    async close() {},
  };
  const f = await sourceHarness(t, { registry });
  for (const input of [
    userInput("Collect 1 item from Sample"),
    { ...userInput("Collect 1 item from sample"), streamingBehavior: "followUp" },
  ]) {
    await f.emit("input", input);
    await assert.rejects(
      f.tools.get("current_feed_collect").execute("ambiguous", { source: "sample", limit: 1 }),
      /COLLECTION_NOT_REQUESTED/,
    );
  }
});

test("a partial collection saves acquired items and leaves its source paused", async (t) => {
  const partial = batch({
    failures: [{ externalId: "two", code: "RATE_LIMITED" }],
    stopReason: "complete",
  });
  const f = await sourceHarness(t, { plugin: sourcePlugin(partial) });
  await f.registry.register(f.modulePath);
  await f.emit("input", userInput("Collect 3 items from sample"));
  const result = await f.tools
    .get("current_feed_collect")
    .execute("partial", { source: "sample", limit: 3 });
  assert.equal(result.structuredContent.count, 1);
  assert.equal(result.structuredContent.status, "RATE_LIMITED");
  assert.equal(result.structuredContent.references.length, 1);
  assert.equal((await f.library.search({ query: "PRIVATE" })).length, 1);
  assert.equal((await f.registry.list())[0].pause, "RATE_LIMITED");
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
});

test("save failure or uncertain acknowledgement never claims saved or retries acquisition", async (t) => {
  for (const failure of ["LIBRARY_STORAGE_ERROR", "LIBRARY_WRITE_UNCERTAIN", "PRIVATE_SECRET"]) {
    await t.test(failure, async (st) => {
      let calls = 0;
      const registry = {
        async list() {
          return [row()];
        },
        async close() {},
        async collect() {
          calls++;
          return batch();
        },
      };
      const library = memoryLibrary({
        async save() {
          throw new Error(failure);
        },
      });
      const f = await sourceHarness(st, { registry, library });
      await f.emit("input", userInput("Collect 1 item from sample"));
      const result = await f.tools
        .get("current_feed_collect")
        .execute("save-failed", { source: "sample", limit: 1 });
      assert.equal(calls, 1);
      assert.equal(result.structuredContent.count, 1);
      assert.deepEqual(result.structuredContent.references, []);
      assert.match(result.structuredContent.message, /not confirmed saved/i);
      assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
      assert.match(JSON.stringify(f.entries), /PRIVATE_BODY/);
      await assert.rejects(
        f.tools.get("current_feed_collect").execute("repeat", { source: "sample", limit: 1 }),
        /COLLECTION_NOT_REQUESTED/,
      );
    });
  }
});

test("library access survives source disabling and removal; deletion requires the exact one-use request", async (t) => {
  const f = await sourceHarness(t);
  await f.registry.register(f.modulePath);
  const saved = await f.library.save(saveRequest());
  const { itemId } = saved.items[0];
  await f.registry.setEnabled("sample", false);
  const feed = await f.tools.get("current_feed_items").execute("enabled-feed-only", {});
  assert.equal(feed.structuredContent.count, 0);
  const search = await f.tools
    .get("current_library_search")
    .execute("offline", { query: "PRIVATE" });
  assert.equal(search.structuredContent.count, 1);
  await f.registry.remove("sample");
  const read = await f.tools.get("current_library_read").execute("removed-source", { itemId });
  assert.equal(read.structuredContent.count, 1);
  assert.ok(!JSON.stringify([search, read]).includes("PRIVATE_"));
  const remove = f.tools.get("current_library_remove");
  await assert.rejects(remove.execute("unrequested", { itemId }), /LIBRARY_REMOVE_NOT_REQUESTED/);
  await f.emit("input", userInput(`Delete saved item ${itemId}`));
  await assert.rejects(
    remove.execute("wrong", { itemId: "11111111-1111-1111-1111-111111111111" }),
    /LIBRARY_REMOVE_NOT_REQUESTED/,
  );
  assert.equal((await remove.execute("remove", { itemId })).structuredContent.count, 1);
  await assert.rejects(remove.execute("repeat", { itemId }), /LIBRARY_REMOVE_NOT_REQUESTED/);
  assert.equal(await f.library.read({ itemId }), undefined);
});

test("late library and collection results cannot append cards after a session transition", async (t) => {
  for (const transition of ["session_shutdown", "session_start"]) {
    for (const operation of ["search", "read", "collect"]) {
      await t.test(`${transition}: ${operation}`, async (st) => {
        const pendingResult = deferred();
        let saves = 0;
        const registry = {
          async list() {
            return [row()];
          },
          async close() {},
          async collect() {
            return pendingResult.promise;
          },
        };
        const library = memoryLibrary({
          async search() {
            return pendingResult.promise;
          },
          async read() {
            return pendingResult.promise;
          },
          async save(request) {
            saves++;
            return { ...request.batch, items: [] };
          },
        });
        const f = await sourceHarness(st, { registry, library });
        if (operation === "collect") await f.emit("input", userInput("Collect 1 item from sample"));
        const tool = f.tools.get(
          operation === "collect" ? "current_feed_collect" : `current_library_${operation}`,
        );
        const args =
          operation === "collect"
            ? { source: "sample", limit: 1 }
            : operation === "search"
              ? { query: "PRIVATE" }
              : { itemId: "11111111-1111-1111-1111-111111111111" };
        const rejected = assert.rejects(tool.execute("late", args), /CANCELLED/);
        await f.emit(transition);
        pendingResult.resolve(
          operation === "collect" ? batch() : operation === "search" ? [item()] : item(),
        );
        await rejected;
        assert.deepEqual(f.entries, []);
        assert.equal(saves, 0);
      });
    }
  }
});

test("a read whose source resolution finishes after session switch cannot start source access", async (t) => {
  const f = await sourceHarness(t);
  await f.registry.register(f.modulePath);
  await f.emit("input", userInput("Read https://example.com/a from Sample"));
  const resolving = deferred();
  t.mock.method(f.registry, "resolve", () => resolving.promise);
  let reads = 0;
  t.mock.method(SourceRegistry.prototype, "read", async () => {
    reads++;
    return item();
  });
  const rejected = assert.rejects(f.api.read("https://example.com/a", 2000), /CANCELLED/);
  await f.emit("session_start");
  resolving.resolve("sample");
  await rejected;
  assert.equal(reads, 0, "expired operations must not use the replacement registry");
  assert.deepEqual(f.entries, []);
});

test("a source dialog opened in the previous session cannot change registrations", async (t) => {
  const f = await sourceHarness(t);
  await f.registry.register(f.modulePath);
  const selectingAction = deferred(),
    action = deferred();
  const notifications = [];
  let selections = 0;
  const pending = f.commands.get("sources").handler("", {
    hasUI: true,
    ui: {
      async select(_title, choices) {
        selections++;
        if (selections === 1) return choices[0];
        if (selections === 2) {
          selectingAction.resolve();
          return action.promise;
        }
        return "Back";
      },
      notify: (...args) => notifications.push(args),
    },
  });
  await selectingAction.promise;
  await f.emit("session_start");
  action.resolve("Disable");
  await pending;
  const inspection = new SourceRegistry({ root: f.data });
  t.after(() => inspection.close());
  assert.equal((await inspection.list())[0].enabled, true);
  assert.deepEqual(notifications, []);
});
