import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mockPages } from "../helpers/page-harness.mjs";
import { feedUrl, feedResponse, hasConditionalValidator } from "./fixtures/feed.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("actual npm artifact prepares and reuses a reading snapshot without live network", async (t) => {
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
    response: feedResponse,
  });
  const data = join(root, "runtime");
  const entry = join(root, "check-preparation.mjs");
  await writeFile(
    entry,
    `import {discoverReading} from ${JSON.stringify(join(installed, "src/reading/discover.ts"))};
import {writeSources} from ${JSON.stringify(join(installed, "src/reading/sources.ts"))};
import {sourceIdFor} from ${JSON.stringify(join(installed, "src/sources/import.ts"))};
import {SQLiteContentLibrary} from ${JSON.stringify(join(installed, "src/library/store.ts"))};
import {randomUUID} from "node:crypto";
export default async function(){
  const dataRoot=${JSON.stringify(data)};
  const source={name:"Fixture reading",url:${JSON.stringify(feedUrl)},enabled:true};
  await writeSources(dataRoot,[source]);
  const sourceId=sourceIdFor(source.url);
  let library=new SQLiteContentLibrary(dataRoot);
  try {
    if(typeof library.prepare!=='function' || typeof library.prepared!=='function') throw new Error('PACKAGED_PREPARATION_API_FAILED');
    const selected=await discoverReading(library,[source],{terms:['article'],limit:1});
    if(selected.items.length!==1 || selected.items[0].item.title!=='Synthetic article') throw new Error('PACKAGED_READING_SELECTION_FAILED');
    const prepared=await library.prepared(sourceId);
    if(!prepared?.batch || prepared.batch.items.length!==2) throw new Error('PACKAGED_PREPARED_BATCH_FAILED');
    if((await library.search({query:'synthetic'})).length!==2) throw new Error('PACKAGED_LIBRARY_FAILED');
    if(!prepared.batch.items[0].text || prepared.batch.items[1].text!==undefined) throw new Error('PACKAGED_CONTENT_KIND_FAILED');
    const repeated=await discoverReading(library,[source],{terms:['article'],limit:1});
    if(repeated.items[0].item.versionId!==selected.items[0].item.versionId) throw new Error('PACKAGED_PREPARATION_REUSE_FAILED');
    const revalidated=await library.prepared(sourceId);
    if(revalidated.batch.id!==prepared.batch.id) throw new Error('PACKAGED_CONDITIONAL_REVALIDATION_FAILED');
    const sourceItem={...prepared.batch.items[0]};
    delete sourceItem.itemId;
    delete sourceItem.versionId;
    const previousText=sourceItem.text;
    sourceItem.text=previousText+' Revised.';
    const revised=await library.save({batch:{id:randomUUID(),sourceId,collectedAt:new Date().toISOString(),items:[sourceItem],failures:[],stopReason:'complete'},requestedCount:1,startedAt:new Date().toISOString()});
    if(revised.items[0].versionId===prepared.batch.items[0].versionId) throw new Error('PACKAGED_MANUAL_SAVE_FAILED');
    if(JSON.stringify(await library.prepared(sourceId))!==JSON.stringify(revalidated)) throw new Error('PACKAGED_SAVE_REPLACED_PREPARATION');
    await library.close();
    library=new SQLiteContentLibrary(dataRoot);
    if(JSON.stringify(await library.prepared(sourceId))!==JSON.stringify(revalidated)) throw new Error('PACKAGED_PREPARATION_REOPEN_FAILED');
    const reopened=await discoverReading(library,[source],{terms:['article'],limit:1});
    if(reopened.items[0].item.versionId!==selected.items[0].item.versionId) throw new Error('PACKAGED_REOPENED_SELECTION_FAILED');
    if((await library.prepared(sourceId)).batch.id!==prepared.batch.id) throw new Error('PACKAGED_REOPENED_REVALIDATION_FAILED');
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
  assert.deepEqual([...extension.commands.keys()], ["source"]);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url.href, feedUrl);
  assert.deepEqual(
    requests.map(({ response }) => response.statusCode),
    [200, 304, 304],
  );
  for (const request of requests.slice(1)) assert.ok(hasConditionalValidator(request));
  assert.deepEqual(
    [...extension.tools.keys()].sort(),
    [
      "current_library_search",
      "current_library_read",
      "current_library_remove",
      "current_reading_find",
      "current_web_search",
      "current_web_read",
    ].sort(),
  );
});
