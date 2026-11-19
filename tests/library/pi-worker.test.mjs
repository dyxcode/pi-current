import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const standalone = process.env.PI_CURRENT_TEST_PI_EXECUTABLE;
const fixture = fileURLToPath(new URL("./fixtures/pi-worker.mjs", import.meta.url));

test(`Library worker handles writes and cancellation under ${standalone ? "standalone Pi" : "Node Pi"}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-current-pi-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = join(root, "agent");
  await mkdir(agent);
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
  // A worker launched in the session directory must not load project preloads.
  await writeFile(join(root, "bunfig.toml"), 'preload = ["./missing-fixture-preload.mjs"]\n');

  const entry = standalone
    ? []
    : [
        fileURLToPath(
          new URL(
            "../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
            import.meta.url,
          ),
        ),
      ];
  await run(
    standalone ?? process.execPath,
    [
      ...entry,
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-approve",
      "--offline",
      "--provider",
      "fixture",
      "--model",
      "fixture",
      "--extension",
      fixture,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        PI_CODING_AGENT_DIR: agent,
        PI_TELEMETRY: "0",
        BUN_BE_BUN: undefined,
      },
      timeout: 15_000,
    },
  );
  const result = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.runtime, standalone ? "bun" : "node");
});
