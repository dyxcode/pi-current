import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const repoRoot = await realpath(join(dirname(fileURLToPath(import.meta.url)), ".."));

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
    for (const [name, field, values, base] of [
      ["current_web_read", "access", ["http", "browser"], { url: "https://example.com/article" }],
      ["current_sources", "action", ["list", "login", "check"], {}],
    ]) {
      const tool = tools.get(name).definition;
      // Provider-facing input enums must avoid anyOf/const encodings.
      const schema = JSON.parse(JSON.stringify(tool.parameters.properties[field]));
      assert.equal(schema.type, "string", `${phase}: ${name}.${field} must be a string enum`);
      assert.deepEqual(schema.enum, values);
      assert.equal(schema.anyOf, undefined);
      for (const value of values) {
        const args = { ...base, [field]: value };
        assert.deepEqual(validateToolArguments(tool, { id: "enum", name, arguments: args }), args);
      }
      assert.throws(() =>
        validateToolArguments(tool, {
          id: "invalid-enum",
          name,
          arguments: { ...base, [field]: "invalid" },
        }),
      );
    }
  }

  assert.deepEqual(loadTimeRequests, [], "startup and reload must not make network requests");
});
