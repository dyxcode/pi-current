import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "pi-current-package-install-"));
const cache = join(root, "cache");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmOptions = ["--ignore-scripts", "--no-audit", "--no-fund", "--cache", cache];
try {
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
  const extension = (
    await readFile(join(repo, "scripts/package-extension.mjs"), "utf8")
  ).replaceAll("__PACKAGE_ROOT__", installed.replaceAll("\\", "\\\\").replaceAll('"', '\\"'));
  await writeFile(join(root, "extension.mjs"), extension);
  await writeFile(join(root, "probe.mjs"), await readFile(join(repo, "scripts/package-probe.mjs")));
  await mkdir(join(root, "unrelated"));
  execFileSync(process.execPath, [join(root, "probe.mjs")], { cwd: root, stdio: "inherit" });
  console.log(
    `PASS: independent production installation on ${process.version}; tested Pi peers ${Object.values(dependencies)[1]}.`,
  );
} finally {
  if (process.env.PI_CURRENT_PACKAGE_CHECK_KEEP === "1")
    console.log(`Retained package fixture: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
