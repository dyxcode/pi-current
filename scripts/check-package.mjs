import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const [standalone, ...extraArgs] = process.argv.slice(2);
if ((standalone !== undefined && !isAbsolute(standalone)) || extraArgs.length > 0) {
  throw new Error("Usage: npm run check:package -- [/absolute/path/to/pi]");
}
const root = await mkdtemp(join(tmpdir(), "pi-current-package-install-"));
const cache = join(root, "cache");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmOptions = ["--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache];

async function checkStandalone(executable, installed, version) {
  if (execFileSync(executable, ["--version"], { encoding: "utf8" }).trim() !== version) {
    throw new Error(`Standalone check requires Pi ${version}`);
  }
  const home = join(root, "home");
  const agent = join(root, "standalone-agent");
  const data = join(root, "data");
  const libraryRoot =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support", "pi-current")
      : join(data, "pi-current");
  await mkdir(agent);
  await mkdir(libraryRoot, { recursive: true });
  await writeFile(join(libraryRoot, "sources.json"), "[]");
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({ packages: [installed], defaultProjectTrust: "never", enableAnalytics: false }),
  );
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "synthetic",
          api: "openai-completions",
          models: [{ id: "fixture", contextWindow: 8192, maxTokens: 1024 }],
        },
      },
    }),
  );
  const extension = join(root, "standalone.mjs");
  await cp(join(repo, "tests/package/fixtures/standalone.mjs"), extension);
  const result = join(root, "standalone-result.json");
  execFileSync(
    executable,
    [
      "--mode",
      "rpc",
      "--offline",
      "--no-approve",
      "--no-session",
      "--provider",
      "fixture",
      "--model",
      "fixture",
      "--extension",
      extension,
    ],
    {
      cwd: join(root, "unrelated"),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_DATA_HOME: data,
        PI_CODING_AGENT_DIR: agent,
        PI_TELEMETRY: "0",
        BUN_BE_BUN: undefined,
        PI_CURRENT_PACKAGE_LIBRARY_ROOT: libraryRoot,
        PI_CURRENT_PACKAGE_RESULT: result,
      },
      stdio: ["pipe", "inherit", "inherit"],
      timeout: 15_000,
    },
  );
  const outcome = JSON.parse(await readFile(result, "utf8"));
  if (outcome.passed !== true) throw new Error(outcome.error ?? "Standalone package probe failed");
  execFileSync(process.execPath, ["--test", join(repo, "tests/library/pi-worker.test.mjs")], {
    cwd: repo,
    env: { ...process.env, PI_CURRENT_TEST_PI_EXECUTABLE: executable },
    stdio: "inherit",
  });
  console.log(
    `PASS: installed Current loads on Pi ${version} standalone and uses its library and parser.`,
  );
}

try {
  execFileSync(npm, ["run", "build:library"], { cwd: repo, stdio: "inherit" });
  const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(repo, "package-lock.json"), "utf8"));
  const [artifact] = JSON.parse(
    execFileSync(
      npm,
      ["pack", "--json", "--ignore-scripts", "--cache", cache, "--pack-destination", root],
      { cwd: repo, encoding: "utf8" },
    ),
  );
  const dependencies = { "pi-current": `file:./${artifact.filename}` };
  for (const name of Object.keys(manifest.peerDependencies)) {
    const version = manifest.devDependencies[name];
    if (!/^\d+\.\d+\.\d+$/.test(version ?? ""))
      throw new Error(`Missing exact tested peer version: ${name}`);
    dependencies[name] = version;
  }
  const fixture = {
    name: "pi-current-package-check",
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies,
    overrides: manifest.overrides,
  };
  await writeFile(join(root, "package.json"), JSON.stringify(fixture, null, 2));
  // Reuse locked transitive versions, then let npm recompute the production graph.
  // No checkout node_modules or development package is linked into this fixture.
  lock.name = fixture.name;
  lock.version = fixture.version;
  lock.packages[""] = { name: fixture.name, version: fixture.version, dependencies };
  await writeFile(join(root, "package-lock.json"), JSON.stringify(lock, null, 2));
  execFileSync(npm, ["install", "--package-lock-only", ...npmOptions], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync(npm, ["ci", "--omit=dev", ...npmOptions], { cwd: root, stdio: "inherit" });
  const installed = join(root, "node_modules", "pi-current");
  await writeFile(
    join(root, "library-consumer.mts"),
    `import { openContentLibrary, type LibraryCandidate, type LibraryContent, type SourceItem, type PreparationRequest, type PreparedSource } from "pi-current/library";
const library = openContentLibrary({ root: "/tmp/pi-current-library-types" });
const version: 2 = library.apiVersion;
async function preparation(request: PreparationRequest) {
  const saved: PreparedSource = await library.prepare(request);
  const loaded: PreparedSource | undefined = await library.prepared(request.sourceId);
  return [saved, loaded];
}
const body: SourceItem = {
  sourceId: "sample",
  externalId: "one",
  url: "https://example.com/a",
  title: "Sample",
  text: "Synthetic body",
  retrievedAt: "2026-01-01T00:00:00.000Z",
  sourceCompleteness: "unknown",
  truncated: false,
};
const candidate: LibraryCandidate = {
  sourceId: "sample",
  externalId: "candidate-1",
  url: "https://example.com/candidate",
  title: "Candidate",
  summary: "Synthetic candidate summary",
  discoveredAt: "2026-01-01T00:00:00.000Z",
};
const content: LibraryContent = candidate;
function inspect(value: LibraryContent) {
  if (typeof value.text === "string") {
    const text: string = value.text;
    const retrievedAt: string = value.retrievedAt;
    const completeness: "unknown" | "known-partial" = value.sourceCompleteness;
    const truncated: boolean = value.truncated;
    void [text, retrievedAt, completeness, truncated];
  } else {
    const discoveredAt: string = value.discoveredAt;
    void discoveredAt;
  }
}
// @ts-expect-error Candidate records do not satisfy the body-only source contract.
const candidateAsSource: SourceItem = candidate;
void [version, body, content, inspect, candidateAsSource, preparation];
`,
  );
  const typeProject = join(root, "tsconfig.library-consumer.json");
  await writeFile(
    typeProject,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          types: [],
        },
        files: ["library-consumer.mts"],
      },
      null,
      2,
    ),
  );
  execFileSync(
    process.execPath,
    [join(repo, "node_modules", "typescript", "bin", "tsc"), "--project", typeProject],
    { cwd: root, stdio: "inherit" },
  );
  const extension = (
    await readFile(join(repo, "tests/package/fixtures/extension.mjs"), "utf8")
  ).replaceAll("__PACKAGE_ROOT__", installed.replaceAll("\\", "\\\\").replaceAll('"', '\\"'));
  await writeFile(join(root, "extension.mjs"), extension);
  await writeFile(
    join(root, "probe.mjs"),
    await readFile(join(repo, "tests/package/fixtures/probe.mjs")),
  );
  await cp(join(repo, "tests/helpers/page-harness.mjs"), join(root, "page-harness.mjs"));
  await cp(join(repo, "tests/package/fixtures/feed.mjs"), join(root, "feed.mjs"));
  await mkdir(join(root, "unrelated"));
  execFileSync(process.execPath, [join(root, "probe.mjs")], { cwd: root, stdio: "inherit" });
  console.log(
    `PASS: independent production installation on ${process.version}; tested Pi peers ${Object.values(dependencies)[1]}.`,
  );
  if (standalone) {
    await checkStandalone(standalone, installed, dependencies["@earendil-works/pi-coding-agent"]);
  }
} finally {
  if (process.env.PI_CURRENT_PACKAGE_CHECK_KEEP === "1")
    console.log(`Retained package fixture: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
