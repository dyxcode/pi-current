import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, cp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("actual npm artifact loads in Pi and registers external JS and TS plugins without network or private files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "current-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--cache",
        join(root, "cache"),
        "--pack-destination",
        root,
      ],
      { cwd: repo, encoding: "utf8" },
    ),
  )[0];
  for (const f of report.files) {
    assert.match(
      f.path,
      /^(package.json|README.md|docs\/i18n\/README.zh-CN.md|src\/|examples\/source-plugin.mjs)/,
    );
    assert.doesNotMatch(f.path, /\.local|agent-docs|cookies|profile|\.sqlite|sources.json/);
  }
  const modules = join(root, "node_modules");
  const installed = join(modules, "pi-current");
  await mkdir(installed, { recursive: true });
  execFileSync("tar", [
    "-xf",
    join(root, report.filename),
    "-C",
    installed,
    "--strip-components=1",
  ]);
  await symlink(join(repo, "node_modules"), join(installed, "node_modules"), "dir");
  const plugin = join(root, "external.mjs");
  await cp(join(installed, "examples/source-plugin.mjs"), plugin);
  const tsPlugin = join(root, "external.ts");
  await writeFile(
    tsPlugin,
    `import plugin from ${JSON.stringify(plugin)};
export default {
  ...plugin,
  id: "typescript",
  async create(context: { sourceId: string; dataDir: string }) {
    return plugin.create(context);
  },
};`,
  );
  const data = join(root, "runtime");
  const entry = join(root, "register.mjs");
  await writeFile(
    entry,
    `import {SourceRegistry} from ${JSON.stringify(join(installed, "src/sources/registry.ts"))};import {SQLiteContentLibrary} from ${JSON.stringify(join(installed, "src/library/store.ts"))};export default async function(pi){const registry=new SourceRegistry({root:${JSON.stringify(data)}});await registry.register(${JSON.stringify(plugin)});await registry.register(${JSON.stringify(tsPlugin)});const batch=await registry.collect('sample',1);const library=new SQLiteContentLibrary(registry.root);await library.save({requestedCount:1,startedAt:new Date().toISOString(),batch:{...batch,id:'11111111-1111-1111-1111-111111111111',sourceId:'sample',collectedAt:new Date().toISOString()}});if((await library.search({query:'synthetic'})).length!==1)throw new Error('PACKAGED_LIBRARY_FAILED');await library.close();await registry.close();}`,
  );
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Unexpected network");
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const cwd = join(root, "unrelated");
  await mkdir(cwd);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(root, "agent"),
    settingsManager: SettingsManager.inMemory({
      packages: [installed],
      enableInstallTelemetry: false,
      enableAnalytics: false,
    }),
    additionalExtensionPaths: [entry],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find(
    (e) => e.resolvedPath === join(installed, "src/index.ts"),
  );
  assert.ok(extension);
  assert.deepEqual([...extension.commands.keys()], ["sources"]);
  assert.equal(extension.tools.size, 10);
});
