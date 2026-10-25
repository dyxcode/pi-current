import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { registerSources } from "../src/pi/sources.ts";
import { sourceHarness, row } from "./helpers/source-harness.mjs";
import { createSearchHarness } from "./helpers/search-harness.mjs";

const connections = [
  { id: "token", name: "Platform credentials", login: true, check: true },
  { id: "session", name: "Website account", login: true, check: true },
];

function accessRegistry(overrides = {}) {
  const calls = [];
  const source = {
    ...row(),
    capabilities: { login: false, check: false, read: false, collect: false },
    connections,
    ...overrides,
  };
  return {
    calls,
    async list() {
      return [source];
    },
    async login(...args) {
      calls.push(["login", ...args]);
    },
    async check(...args) {
      calls.push(["check", ...args]);
    },
    async close() {},
  };
}

function dialog(choices, onSelect = () => {}) {
  const menus = [];
  const notices = [];
  return {
    menus,
    notices,
    context: {
      hasUI: true,
      ui: {
        async select(title, options) {
          menus.push({ title, options });
          await onSelect(title);
          if (!choices.length) return "Back";
          const next = choices.shift();
          if (next === "source") return options[0];
          if (next !== undefined) assert.ok(options.includes(next), `${title}: missing ${next}`);
          return next;
        },
        notify(message, level) {
          notices.push({ message, level });
        },
      },
    },
  };
}

test("real Pi source command displays every cached connection without constructing an adapter", async (t) => {
  const plugin = `export default {
    apiVersion:1,id:'sample',name:'Sample',hosts:['example.com'],
    capabilities:{login:false,check:false,read:false,collect:false},
    connections:${JSON.stringify(connections)},
    async create(){throw new Error('ADAPTER_MUST_STAY_CLOSED')}
  }`;
  const f = await sourceHarness(t, { plugin });
  await f.registry.register(f.modulePath);
  await mkdir(join(f.data, "source-state"), { recursive: true });
  const statePath = join(f.data, "source-state/sample.json");
  const states = {
    auth: "not-required",
    connections: {
      token: { auth: "ready", checkedAt: "2026-01-01T00:00:00Z" },
      session: {
        auth: "expired",
        checkedAt: "2026-01-02T00:00:00Z",
        pause: "RATE_LIMITED",
        problem: "AUTH_EXPIRED",
      },
    },
  };
  await writeFile(statePath, JSON.stringify(states));
  const before = await readFile(statePath);
  const h = await createSearchHarness(t);
  const extension = await loadExtensionFromFactory(
    (pi) => registerSources(pi, { root: f.data, registry: f.registry, library: f.library }),
    h.cwd,
    createEventBus(),
    h.loader.getExtensions().runtime,
  );
  h.loader.getExtensions().runtime.appendEntry = (name, data) => f.entries.push({ name, data });
  const d = dialog(["source", "View status", "Back"]);
  await extension.commands.get("sources").handler("", d.context);
  assert.equal(d.menus.length, 3, "status must not open a connection picker");
  assert.equal(d.menus[0].options.length, 3, "one source plus Add source and Back");
  assert.deepEqual(d.menus[1].options, [
    "View status",
    "Set up access…",
    "Disable",
    "Remove source",
    "Back",
  ]);
  assert.deepEqual(d.notices, []);
  const displayed = JSON.stringify(f.entries);
  for (const text of [
    "Platform credentials: ready",
    "Website account: expired",
    "2026-01-01T00:00:00Z",
    "2026-01-02T00:00:00Z",
    "RATE_LIMITED",
    "AUTH_EXPIRED",
  ])
    assert.ok(displayed.includes(text), `status must include ${text}`);
  assert.ok(!displayed.includes("[token]"));
  assert.ok(!displayed.includes("[session]"));
  assert.deepEqual(await readFile(statePath), before);
});

test("access setup selects a friendly connection name and configures only its stable ID", async (t) => {
  const registry = accessRegistry();
  const f = await sourceHarness(t, { registry });
  const d = dialog(["source", "Set up access…", "Website account", "Back"]);
  await f.commands.get("sources").handler("", d.context);
  assert.equal(d.menus[2].title, "Set up access — Sample");
  assert.deepEqual(d.menus[2].options, ["Platform credentials", "Website account", "Back"]);
  assert.equal(registry.calls.length, 1);
  assert.equal(registry.calls[0][0], "login");
  assert.equal(registry.calls[0][1], "sample");
  assert.equal(registry.calls[0][3], "session");
});

test("Back and dismissed access setup perform no login or check", async (t) => {
  for (const choice of ["Back", undefined]) {
    const registry = accessRegistry();
    const f = await sourceHarness(t, { registry });
    const d = dialog(["source", "Set up access…", choice, "Back"]);
    await f.commands.get("sources").handler("", d.context);
    assert.deepEqual(registry.calls, []);
  }
});

test("one available setup method starts directly for both legacy and named connections", async (t) => {
  for (const named of [false, true]) {
    const registry = accessRegistry({
      capabilities: { login: !named, check: true, read: false, collect: false },
      connections: named ? [connections[0], { ...connections[1], login: false }] : undefined,
    });
    const f = await sourceHarness(t, { registry });
    const d = dialog(["source", "Set up access…", "Back"]);
    await f.commands.get("sources").handler("", d.context);
    assert.equal(d.menus.length, 3);
    assert.equal(registry.calls.length, 1);
    assert.equal(registry.calls[0][0], "login");
    assert.equal(registry.calls[0][3], named ? "token" : undefined);
  }
});

test("a source without setup capability can still display status", async (t) => {
  const registry = accessRegistry({ connections: [] });
  const f = await sourceHarness(t, { registry });
  const d = dialog(["source", "View status", "Back"]);
  await f.commands.get("sources").handler("", d.context);
  assert.ok(!d.menus[1].options.includes("Set up access…"));
  assert.deepEqual(registry.calls, []);
  assert.equal(f.entries.length, 1);
});

test("duplicate and reserved connection names remain independently selectable", async (t) => {
  const registry = accessRegistry({
    capabilities: { login: true, check: false, read: false, collect: false },
    connections: [
      { ...connections[0], name: "Source access" },
      { ...connections[1], name: "Source access" },
      { id: "back", name: "Back", login: true, check: false },
    ],
  });
  const f = await sourceHarness(t, { registry });
  const d = dialog([
    "source",
    "Set up access…",
    "3. Source access",
    "source",
    "Set up access…",
    "4. Back",
    "Back",
  ]);
  await f.commands.get("sources").handler("", d.context);
  assert.deepEqual(d.menus[2].options, [
    "1. Source access",
    "2. Source access",
    "3. Source access",
    "4. Back",
    "Back",
  ]);
  assert.deepEqual(
    registry.calls.map(([method, source, _signal, connection]) => [method, source, connection]),
    [
      ["login", "sample", "session"],
      ["login", "sample", "back"],
    ],
  );
});

test("login-only connections finish setup without suggesting an unavailable check", async (t) => {
  const registry = accessRegistry({
    connections: [{ ...connections[0], check: false }],
  });
  const f = await sourceHarness(t, { registry });
  const d = dialog(["source", "Set up access…", "Back"]);
  await f.commands.get("sources").handler("", d.context);
  assert.equal(registry.calls.length, 1);
  assert.equal(d.notices.length, 1);
  assert.equal(d.notices[0].level, "info");
  assert.ok(!/request.*check/i.test(d.notices[0].message));
});

test("a connection picker from a closed Pi session cannot start access setup", async (t) => {
  const registry = accessRegistry();
  const f = await sourceHarness(t, { registry });
  const d = dialog(["source", "Set up access…", "Website account"], async (title) => {
    if (title === "Set up access — Sample") await f.emit("session_shutdown");
  });
  await f.commands.get("sources").handler("", d.context);
  assert.deepEqual(registry.calls, []);
  assert.deepEqual(d.notices, []);
});
