import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const repoRoot = await realpath(join(dirname(fileURLToPath(import.meta.url)), "../.."));

test("Pi discovers the package from another directory and reloads it without duplication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-current-loading-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "unrelated-project");
  const agentDir = join(root, "isolated-agent");
  await mkdir(cwd);
  await mkdir(agentDir);

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({
      packages: [repoRoot],
      enableInstallTelemetry: false,
      enableAnalytics: false,
    }),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  const originalFetch = globalThis.fetch;
  const loadTimeRequests = [];
  globalThis.fetch = async (input) => {
    loadTimeRequests.push(String(input));
    throw new Error("Extension loading must not access the network");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  for (const phase of ["startup", "reload"]) {
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, [], `${phase}: Pi must report no loading errors`);
    assert.deepEqual(result.warnings ?? [], [], `${phase}: Pi must report no loading warnings`);
    const extensions = result.extensions.filter(
      (extension) => extension.resolvedPath === join(repoRoot, "src", "index.ts"),
    );
    assert.equal(extensions.length, 1, `${phase}: the package must load exactly once`);
    assert.equal(extensions[0].sourceInfo.scope, "user");
    assert.equal(extensions[0].sourceInfo.origin, "package");
    assert.deepEqual(
      [...extensions[0].tools.keys()].filter((name) => name.startsWith("current_web_")),
      ["current_web_search", "current_web_read"],
      `${phase}: search and read tools must each be registered once`,
    );
    const tools = extensions[0].tools;
    assert.deepEqual(
      [...tools.keys()].sort(),
      [
        "current_library_read",
        "current_library_remove",
        "current_library_search",
        "current_reading_find",
        "current_source_import",
        "current_web_read",
        "current_web_search",
      ],
      `${phase}: Pi exposes seven reading, direct import, library and public web tools`,
    );
    const read = tools.get("current_web_read").definition;
    assert.deepEqual(
      Object.keys(read.parameters.properties).sort(),
      ["maxCharacters", "url"],
      `${phase}: public page reading has no source or browser routing`,
    );
    const importTool = tools.get("current_source_import").definition;
    assert.deepEqual(Object.keys(importTool.parameters.properties).sort(), ["limit", "url"]);
    assert.equal(importTool.prepareArguments, undefined);
    assert.match(importTool.promptGuidelines.join(" "), /current.*(reading|retrieval).*task/i);
    assert.match(importTool.promptGuidelines.join(" "), /choose|select/i);
    assert.match(importTool.promptGuidelines.join(" "), /feed URL/i);
    assert.doesNotMatch(
      importTool.promptGuidelines.join(" "),
      /Do not use it for recommendations/i,
    );
    assert.equal(tools.has("current_sources"), false);
    assert.deepEqual([...extensions[0].commands.keys()], ["source"]);
    const reading = tools.get("current_reading_find").definition;
    assert.deepEqual(Object.keys(reading.parameters.properties).sort(), ["limit", "terms"]);
    assert.equal(
      extensions[0].commands.has("sources"),
      false,
      `${phase}: Pi does not register a /sources module-management command`,
    );
    for (const obsolete of [
      "current_source_operation",
      "current_source_save",
      "current_feed_collect",
    ])
      assert.equal(tools.has(obsolete), false, `${phase}: ${obsolete} is not registered`);
  }

  assert.deepEqual(loadTimeRequests, [], "startup and reload must not make network requests");
});
