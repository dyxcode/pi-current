import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mockPages } from "../helpers/page-harness.mjs";
import { feedUrl, feedXml } from "./fixtures/feed.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("actual npm artifact imports a feed through its installed parser and library without live network", async (t) => {
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
      /^(package.json|README.md|docs\/i18n\/README.zh-CN.md|src\/|dist\/library-api\/)/,
    );
    assert.doesNotMatch(f.path, /\.local|\.agent|cookies|profile|\.sqlite|sources.json/);
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
  const { requests } = mockPages(t, {
    response: () => ({ body: feedXml, headers: { "content-type": "application/rss+xml" } }),
  });
  const data = join(root, "runtime");
  const entry = join(root, "check-import.mjs");
  await writeFile(
    entry,
    `import {importFeed} from ${JSON.stringify(join(installed, "src/sources/import.ts"))};
import {SQLiteContentLibrary} from ${JSON.stringify(join(installed, "src/library/store.ts"))};
export default async function(){
  const library=new SQLiteContentLibrary(${JSON.stringify(data)});
  try {
    const result=await importFeed(library,{url:${JSON.stringify(feedUrl)}});
    if(result.batch.items.length!==2 || result.issues.length) throw new Error('PACKAGED_IMPORT_FAILED');
    if((await library.search({query:'synthetic'})).length!==2)throw new Error('PACKAGED_LIBRARY_FAILED');
    if(!result.batch.items[0].text || result.batch.items[1].text!==undefined) throw new Error('PACKAGED_CONTENT_KIND_FAILED');
  } finally {await library.close();}
}`,
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
  assert.deepEqual([...extension.commands.keys()], []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.href, feedUrl);
  assert.deepEqual(
    [...extension.tools.keys()].sort(),
    [
      "current_source_import",
      "current_library_search",
      "current_library_read",
      "current_library_remove",
      "current_web_search",
      "current_web_read",
    ].sort(),
  );
});
