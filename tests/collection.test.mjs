import assert from "node:assert/strict";
import { test } from "node:test";
import { collectAndSave } from "../src/sources/collection.ts";
import { batch, deferred, memoryLibrary } from "./helpers/source-harness.mjs";

test("collection and persistence run without Pi and preserve one batch identity and provenance", async () => {
  const acquired = batch();
  const calls = [];
  const collector = {
    async collect(source, limit) {
      calls.push([source, limit]);
      return acquired;
    },
  };
  const library = memoryLibrary({
    async save(request) {
      calls.push(request);
      return { ...request.batch, items: [] };
    },
  });
  const outcome = await collectAndSave(collector, library, { sourceId: "sample", limit: 3 });
  assert.deepEqual(calls[0], ["sample", 3]);
  assert.equal(calls[1].requestedCount, 3);
  assert.equal(outcome.batch.id, calls[1].batch.id);
  assert.equal(outcome.batch.sourceId, "sample");
  assert.deepEqual(outcome.batch.items, acquired.items);
  assert.equal(outcome.storage.status, "saved");
  assert.equal(outcome.storage.batch.id, outcome.batch.id);
});

test("partial acquisition and its first failure survive a successful save", async () => {
  const acquired = batch({
    failures: [{ externalId: "two", code: "RATE_LIMITED" }],
    stopReason: "RATE_LIMITED",
  });
  const outcome = await collectAndSave(
    {
      async collect() {
        return acquired;
      },
    },
    memoryLibrary(),
    { sourceId: "sample", limit: 3 },
  );
  assert.equal(outcome.storage.status, "saved");
  assert.deepEqual(outcome.storage.batch.failures, acquired.failures);
  assert.equal(outcome.storage.batch.items.length, 1);
  assert.equal(outcome.batch.stopReason, "RATE_LIMITED");
});

test("unacknowledged saves retain acquired items, sanitize errors and never recollect", async (t) => {
  for (const failure of [
    "LIBRARY_WRITE_UNCERTAIN",
    "LIBRARY_STORAGE_ERROR",
    "PRIVATE_SECRET",
    "LIBRARY_PRIVATE_SECRET",
  ]) {
    await t.test(failure, async () => {
      let collections = 0,
        saves = 0;
      const outcome = await collectAndSave(
        {
          async collect() {
            collections++;
            return batch();
          },
        },
        memoryLibrary({
          async save() {
            saves++;
            throw new Error(failure);
          },
        }),
        { sourceId: "sample", limit: 1 },
      );
      assert.equal(collections, 1);
      assert.equal(saves, 1);
      assert.equal(outcome.batch.items.length, 1);
      assert.equal(outcome.storage.status, "unconfirmed");
      assert.equal(
        outcome.storage.code,
        failure.includes("PRIVATE") ? "LIBRARY_STORAGE_ERROR" : failure,
      );
      assert.equal("batch" in outcome.storage, false);
    });
  }
});

test("cancellation before or during acquisition prevents starting persistence", async () => {
  const controller = new AbortController();
  const acquiring = deferred();
  let collections = 0,
    saves = 0;
  const collector = {
    async collect() {
      collections++;
      return acquiring.promise;
    },
  };
  const library = memoryLibrary({
    async save() {
      saves++;
      throw new Error("UNEXPECTED_SAVE");
    },
  });
  const pending = assert.rejects(
    collectAndSave(collector, library, { sourceId: "sample", limit: 1 }, controller.signal),
    /CANCELLED/,
  );
  controller.abort();
  acquiring.resolve(batch());
  await pending;
  await assert.rejects(
    collectAndSave(collector, library, { sourceId: "sample", limit: 1 }, controller.signal),
    /CANCELLED/,
  );
  assert.equal(collections, 1);
  assert.equal(saves, 0);
});

test("invalid collection inputs fail before source or storage access", async () => {
  let calls = 0;
  const collector = {
    async collect() {
      calls++;
      return batch();
    },
  };
  for (const limit of [0, 11, 1.5, NaN]) {
    await assert.rejects(
      collectAndSave(collector, memoryLibrary(), { sourceId: "sample", limit }),
      /SOURCE_INVALID_INPUT/,
    );
  }
  assert.equal(calls, 0);
});
