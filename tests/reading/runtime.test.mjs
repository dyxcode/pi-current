import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SQLiteContentLibrary } from "../../src/library/store.ts";
import { writeSources } from "../../src/reading/sources.ts";
import { PreparationRuntime } from "../../src/reading/runtime.ts";
import { mockPages } from "../helpers/page-harness.mjs";

const source = { name: "Fixture", url: "https://example.com/feed", enabled: true };
const feed =
  '<rss version="2.0"><channel><item><guid>a</guid><title>Article</title><link>https://example.com/a</link><description>Summary</description></item></channel></rss>';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "current-preparation-runtime-"));
  const library = new SQLiteContentLibrary(root);
  const notices = [];
  const runtime = new PreparationRuntime(root, library, (result) => notices.push(result));
  t.after(async () => {
    await runtime.stop();
    await library.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeSources(root, [source]);
  return { root, library, runtime, notices };
}

test("startup and simultaneous recommendation requests share preparation; validators survive restart", async (t) => {
  const { requests } = mockPages(t, {
    response: ({ options }) =>
      options.headers["if-none-match"]
        ? { status: 304 }
        : { body: feed, headers: { etag: '"v1"' } },
  });
  const f = await fixture(t);
  f.runtime.start();
  const [left, right] = await Promise.all([f.runtime.ensure(), f.runtime.ensure()]);
  assert.equal(requests.length, 1);
  assert.equal(left.feeds[0].batch.items[0].itemId, right.feeds[0].batch.items[0].itemId);
  assert.equal(f.notices.length, 1);
  await f.runtime.stop();
  f.runtime.start();
  await f.runtime.ensure();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers["if-none-match"], '"v1"');
});

test("an aborted reader stops waiting without cancelling shared background preparation", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { requests } = mockPages(t, {
    response: async () => {
      await gate;
      return { body: feed };
    },
  });
  const f = await fixture(t);
  f.runtime.start();
  const controller = new AbortController();
  const waiting = f.runtime.ensure(controller.signal);
  controller.abort();
  await assert.rejects(waiting, /CANCELLED/);
  release();
  const prepared = await f.runtime.ensure();
  assert.equal(prepared.processed, 1);
  assert.equal(requests.length, 1);
});

test("source changes replace pending preparation and exclude disabled sources", async (t) => {
  const { requests } = mockPages(t, {
    response: ({ options }) =>
      options.headers["if-none-match"]
        ? { status: 304 }
        : { body: feed, headers: { etag: '"v1"' } },
  });
  const f = await fixture(t);
  f.runtime.start();
  await f.runtime.ensure();
  await writeSources(f.root, [{ ...source, enabled: false }]);
  await f.runtime.sourcesChanged();
  const prepared = await f.runtime.ensure();
  assert.equal(prepared.enabledSources, 0);
  assert.equal(requests.length, 1);
});

test("stopping an active preparation cancels network work and publishes no result", async (t) => {
  let started;
  const begun = new Promise((resolve) => {
    started = resolve;
  });
  mockPages(t, {
    response: async () => {
      started();
      return new Promise(() => {});
    },
  });
  const f = await fixture(t);
  f.runtime.start();
  const pending = f.runtime.ensure();
  const rejected = assert.rejects(pending, /CANCELLED/);
  await begun;
  await f.runtime.stop();
  await rejected;
  assert.equal(f.notices.length, 0);
});

test("an idle runtime does not poll sources; a later recommendation revalidates", async (t) => {
  const { requests } = mockPages(t, {
    response: ({ options }) =>
      options.headers["if-none-match"]
        ? { status: 304 }
        : { body: feed, headers: { etag: '"v1"' } },
  });
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  f.runtime.start();
  await f.runtime.ensure();
  assert.equal(requests.length, 1);
  t.mock.timers.tick(7 * 24 * 60 * 60 * 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1, "idle standalone Pi does not poll");
  const prepared = await f.runtime.ensure();
  assert.equal(requests.length, 2);
  assert.equal(prepared.processed, 0, "304 reuses content without saving a new batch");
});
