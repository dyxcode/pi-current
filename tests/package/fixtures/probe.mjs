import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, sep } from "node:path";

const root = process.cwd();
const installed = join(root, "node_modules", "pi-current");
const nodeOnlyEnv = { ...process.env };
delete nodeOnlyEnv.NODE_OPTIONS;
const nodeOnlyProbe = `
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openContentLibrary } from "pi-current/library";

const root = await mkdtemp(join(tmpdir(), "pi-current-library-node-only-"));
const library = openContentLibrary({ root });
const collectedAt = "2026-11-03T00:00:00.000Z";
const candidate = {
  sourceId: "sample",
  externalId: "one",
  url: "https://example.com/a",
  title: "Sample",
  summary: "Synthetic discovery summary",
  discoveredAt: collectedAt,
};
try {
  assert.equal(library.apiVersion, 2);
  const first = await library.save({
    batch: {
      id: randomUUID(),
      sourceId: "sample",
      collectedAt,
      items: [candidate],
      failures: [],
      stopReason: "complete",
    },
    requestedCount: 1,
    startedAt: collectedAt,
  });
  const firstItem = first.items[0];
  assert.ok(firstItem);
  assert.equal("text" in firstItem, false);
  assert.equal("retrievedAt" in firstItem, false);
  assert.equal("sourceCompleteness" in firstItem, false);
  assert.equal("truncated" in firstItem, false);
  await library.close();

  const reopened = openContentLibrary({ root });
  assert.equal(reopened.apiVersion, 2);
  const discovered = await reopened.search({ query: "discovery summary" });
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.itemId, firstItem.itemId);
  assert.equal(discovered[0]?.versionId, firstItem.versionId);
  const historicalCandidate = await reopened.read({
    itemId: firstItem.itemId,
    versionId: firstItem.versionId,
  });
  assert.ok(historicalCandidate);
  assert.equal(historicalCandidate.discoveredAt, candidate.discoveredAt);
  assert.equal("text" in historicalCandidate, false);

  const sourceItem = {
    ...candidate,
    text: "Enriched synthetic body",
    retrievedAt: collectedAt,
    sourceCompleteness: "unknown",
    truncated: false,
  };

  const revised = await reopened.save({
    batch: {
      id: randomUUID(),
      sourceId: "sample",
      collectedAt,
      items: [sourceItem],
      failures: [],
      stopReason: "complete",
    },
    requestedCount: 1,
    startedAt: collectedAt,
  });
  assert.equal(revised.items[0]?.itemId, firstItem.itemId);
  assert.notEqual(revised.items[0]?.versionId, firstItem.versionId);
  assert.equal(
    (await reopened.read({ itemId: firstItem.itemId, versionId: firstItem.versionId }))?.discoveredAt,
    candidate.discoveredAt,
  );
  assert.equal(
    (await reopened.read({ itemId: firstItem.itemId }))?.text,
    sourceItem.text,
  );
  await reopened.close();

  const finalLibrary = openContentLibrary({ root });
  try {
    const latest = await finalLibrary.read({ itemId: firstItem.itemId });
    const history = await finalLibrary.read({ itemId: firstItem.itemId, versionId: firstItem.versionId });
    assert.equal(latest?.versionId, revised.items[0]?.versionId);
    assert.equal(latest?.text, sourceItem.text);
    assert.equal(history?.discoveredAt, candidate.discoveredAt);
    assert.equal("text" in (history ?? {}), false);
  } finally {
    await finalLibrary.close();
  }
} finally {
  await library.close();
  await rm(root, { recursive: true, force: true });
}
`;
execFileSync(process.execPath, ["--input-type=module", "-e", nodeOnlyProbe], {
  cwd: root,
  env: nodeOnlyEnv,
  stdio: "inherit",
});
console.log("PASS: installed library entry imports and reads through standalone Node.");
const require = createRequire(join(installed, "package.json"));
for (const name of [
  "@modelcontextprotocol/sdk/client/index.js",
  "@mozilla/readability",
  "ipaddr.js",
  "jsdom",
]) {
  const resolved = await realpath(require.resolve(name));
  assert.ok(
    resolved.startsWith(root + sep),
    `${name} must resolve inside the independent installation`,
  );
}
assert.equal((await lstat(installed)).isSymbolicLink(), false);
await assert.rejects(lstat(join(root, "node_modules/playwright")), { code: "ENOENT" });

globalThis.fetch = async () => {
  throw new Error("Unexpected network request during package probe");
};
const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const loader = new DefaultResourceLoader({
  cwd: join(root, "unrelated"),
  agentDir: join(root, "agent"),
  settingsManager: SettingsManager.inMemory({
    packages: [installed],
    enableInstallTelemetry: false,
    enableAnalytics: false,
  }),
  additionalExtensionPaths: [join(root, "extension.mjs")],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions.find(
  (value) => value.resolvedPath === join(installed, "src/index.ts"),
);
assert.ok(extension);
assert.equal(extension.tools.size, 6);
assert.deepEqual([...extension.commands.keys()], []);
console.log(
  "PASS: isolated Pi loading, built-in RSS parsing, HTML worker and SQLite import workflow.",
);
