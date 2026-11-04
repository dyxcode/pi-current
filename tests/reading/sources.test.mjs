import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSources, writeSources } from "../../src/reading/sources.ts";

const defaults = [
  { name: "MIT Research", url: "https://news.mit.edu/rss/research", enabled: true },
  { name: "JSTOR Daily", url: "https://daily.jstor.org/feed", enabled: true },
  { name: "Psyche", url: "https://psyche.co/feed.rss", enabled: true },
];

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-current-reading-sources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a missing source list returns fresh defaults without writing runtime data", async (t) => {
  const root = await temporaryRoot(t);

  const sources = await readSources(root);

  assert.deepEqual(sources, defaults);
  assert.deepEqual(await readdir(root), []);
});

test("added and updated sources persist after reopening and URLs are normalized", async (t) => {
  const root = await temporaryRoot(t);
  const added = {
    name: "  Local Lab  ",
    url: "HTTPS://Feeds.Example.test:443/lab.xml#section",
    enabled: true,
  };

  await writeSources(root, [...defaults, added]);
  const persisted = await readSources(root);

  assert.deepEqual(persisted, [
    ...defaults,
    { name: "Local Lab", url: "https://feeds.example.test/lab.xml", enabled: true },
  ]);

  await writeSources(
    root,
    persisted
      .map((source) => ({
        ...source,
        enabled: source.name !== "MIT Research",
      }))
      .filter((source) => source.name !== "JSTOR Daily"),
  );

  assert.deepEqual(await readSources(root), [
    { name: "MIT Research", url: defaults[0].url, enabled: false },
    { name: "Psyche", url: defaults[2].url, enabled: true },
    { name: "Local Lab", url: "https://feeds.example.test/lab.xml", enabled: true },
  ]);
});

test("an empty source list remains empty instead of restoring defaults", async (t) => {
  const root = await temporaryRoot(t);

  await writeSources(root, []);

  assert.deepEqual(await readSources(root), []);
});

test("sources may all be disabled without being removed or re-enabled", async (t) => {
  const root = await temporaryRoot(t);
  const disabled = defaults.map((source) => ({ ...source, enabled: false }));

  await writeSources(root, disabled);

  assert.deepEqual(await readSources(root), disabled);
});

test("duplicate normalized feed URLs fail with a useful error", async (t) => {
  const root = await temporaryRoot(t);
  const duplicate = [
    { name: "First", url: "https://feeds.example.test/main.xml", enabled: true },
    { name: "Second", url: "HTTPS://FEEDS.EXAMPLE.TEST:443/main.xml#latest", enabled: false },
  ];

  await assert.rejects(writeSources(root, duplicate), /duplicate.*(feed )?URL/i);
  assert.deepEqual(await readSources(root), defaults);
});

test("invalid source data loaded from disk is rejected rather than repaired", async (t) => {
  const root = await temporaryRoot(t);
  await writeSources(root, defaults);
  const entries = await readdir(root);
  assert.equal(entries.length, 1);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, entries[0]), JSON.stringify([{ name: "missing fields" }]));

  await assert.rejects(readSources(root), /invalid source/i);
});
