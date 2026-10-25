import assert from "node:assert/strict";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, sep } from "node:path";

const root = process.cwd();
const installed = join(root, "node_modules", "pi-current");
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

const pluginDir = join(root, "external-plugins");
const helperDir = join(pluginDir, "node_modules", "probe-helper");
await mkdir(helperDir, { recursive: true });
await writeFile(
  join(helperDir, "package.json"),
  JSON.stringify({
    name: "probe-helper",
    version: "1.0.0",
    type: "module",
    exports: "./index.mjs",
  }),
);
await writeFile(
  join(helperDir, "index.mjs"),
  "export const body = 'Synthetic independent plugin dependency.';",
);
const plugin = `import { body } from 'probe-helper';
export default {
  apiVersion: 1, id: 'sample', name: 'Sample', hosts: ['example.com'],
  capabilities: { login: false, check: false, read: true, collect: true },
  async create({ sourceId }) {
    const item = { sourceId, externalId: 'one', url: 'https://example.com/a', title: 'Synthetic', text: body, retrievedAt: '2026-01-01T00:00:00.000Z', sourceCompleteness: 'unknown', truncated: false };
    return { async read() { return item; }, async collect() { return { items: [item], failures: [], stopReason: 'limit' }; }, async close() {} };
  },
};`;
await writeFile(join(pluginDir, "sample.mjs"), plugin);
await writeFile(
  join(pluginDir, "sample.ts"),
  plugin
    .replace("id: 'sample'", "id: 'typescript'")
    .replace("async create({ sourceId })", "async create({ sourceId }: { sourceId: string })"),
);

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
assert.equal(extension.tools.size, 10);
assert.deepEqual([...extension.commands.keys()], ["sources"]);
console.log(
  "PASS: isolated Pi loading, external JS/TS plugin dependencies, HTML worker and SQLite collection workflow.",
);
