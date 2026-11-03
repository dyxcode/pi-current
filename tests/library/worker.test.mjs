import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// Exercise the actual public adapter against a deterministic child process.
// Schema/data migration itself is covered using SQLite in library-migration.test.mjs.
async function fixture(t, behavior) {
  const root = await mkdtemp(join(tmpdir(), "library-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "library"));
  await mkdir(join(root, "sources"));
  for (const name of ["store.ts", "validation.mjs"])
    await cp(new URL(`../../src/library/${name}`, import.meta.url), join(root, "library", name));
  await cp(
    new URL("../../src/sources/content-limits.mjs", import.meta.url),
    join(root, "sources/content-limits.mjs"),
  );
  await writeFile(
    join(root, "library/worker.mjs"),
    `process.once('message', () => { ${behavior} });`,
  );
  const { SQLiteContentLibrary } = await import(pathToFileURL(join(root, "library/store.ts")).href);
  const library = new SQLiteContentLibrary(join(root, "data"));
  t.after(() => library.close());
  return library;
}

test("a cancellable migration can exceed the ordinary query deadline", async (t) => {
  const library = await fixture(
    t,
    `
    process.send({phase: 'migration'});
    setTimeout(() => {
      process.send({phase: 'operation'});
      process.send({ok: true, result: []}, () => process.exit(0));
    }, 5200);
  `,
  );
  assert.deepEqual(await library.search({ query: "candidate" }), []);
});

test("cancelling during migration terminates the worker", async (t) => {
  const library = await fixture(
    t,
    `
    process.send({phase: 'migration'});
    setInterval(() => {}, 1000);
  `,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    await assert.rejects(
      library.search({ query: "candidate" }, controller.signal),
      /LIBRARY_CANCELLED/,
    );
  } finally {
    clearTimeout(timer);
  }
});

test("the ordinary query deadline resumes after migration", async (t) => {
  const library = await fixture(
    t,
    `
    process.send({phase: 'migration'});
    process.send({phase: 'operation'});
    setInterval(() => {}, 1000);
  `,
  );
  await assert.rejects(library.search({ query: "candidate" }), /LIBRARY_TIMEOUT/);
});
