import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerSourceMenu } from "../../src/pi/source-menu.ts";
import { readSources, writeSources } from "../../src/reading/sources.ts";

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-current-source-menu-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function sourceLabel(source, index) {
  const state = source.enabled ? "Enabled" : "Disabled";
  return `${index + 1}. ${source.name} — ${state} — ${source.url}`;
}

function commandHarness(
  root,
  { selections = [], inputs = [], hasUI = true, onChanged = async () => {} } = {},
) {
  const commands = new Map();
  const calls = { selections: [], inputs: [], notifications: [] };
  const pi = {
    registerCommand(name, definition) {
      assert.equal(commands.has(name), false, `/${name} should be registered once`);
      commands.set(name, definition);
    },
  };
  const ui = {
    async select(title, options) {
      calls.selections.push({ title, options });
      const next = selections.shift();
      const choice = typeof next === "function" ? await next(title, options) : next;
      if (choice !== undefined) assert.ok(options.includes(choice), `unexpected choice: ${choice}`);
      return choice;
    },
    async input(title, placeholder) {
      calls.inputs.push({ title, placeholder });
      return inputs.shift();
    },
    notify(message, type) {
      calls.notifications.push({ message, type });
    },
  };
  registerSourceMenu(pi, root, onChanged);

  return {
    calls,
    async run() {
      await commands.get("source").handler("", { hasUI, ui });
    },
  };
}

test("/source lists existing sources and only offers toggle and back actions", async (t) => {
  const root = await temporaryRoot(t);
  const sources = await readSources(root);
  const labels = sources.map(sourceLabel);
  const menu = commandHarness(root, {
    selections: [
      (title, options) => {
        assert.equal(title, "Reading sources");
        assert.deepEqual(options, labels);
        assert.ok(options.every((row) => / — (Enabled|Disabled) — https:\/\//u.test(row)));
        assert.ok(options.every((row) => !/Add source|Remove source/u.test(row)));
        return labels[0];
      },
      (title, options) => {
        assert.equal(title, "Source: MIT Research");
        assert.deepEqual(options, ["Disable source", "Back to sources"]);
        return "Back to sources";
      },
      (_title, options) => {
        assert.deepEqual(options, labels);
        return undefined;
      },
    ],
  });

  await menu.run();

  assert.deepEqual(await readSources(root), sources);
  assert.equal(menu.calls.inputs.length, 0);
});

test("/source toggles the selected URL and preserves sources added while menus are open", async (t) => {
  const root = await temporaryRoot(t);
  const sourceA = { name: "Shared", url: "https://feeds.example.test/a.xml", enabled: true };
  const sourceB = { name: "Shared", url: "https://feeds.example.test/b.xml", enabled: true };
  const sourceC = {
    name: "Added before selection",
    url: "https://feeds.example.test/c.xml",
    enabled: true,
  };
  const sourceD = {
    name: "Added before toggle",
    url: "https://feeds.example.test/d.xml",
    enabled: true,
  };
  await writeSources(root, [sourceA, sourceB]);
  let callbackSnapshot;
  const menu = commandHarness(root, {
    onChanged: async () => {
      callbackSnapshot = await readSources(root);
    },
    selections: [
      async (title, options) => {
        assert.equal(title, "Reading sources");
        assert.deepEqual(options, [sourceLabel(sourceA, 0), sourceLabel(sourceB, 1)]);
        await writeSources(root, [sourceC, sourceA, sourceB]);
        return sourceLabel(sourceA, 0);
      },
      async (title, options) => {
        assert.equal(title, "Source: Shared");
        assert.deepEqual(options, ["Disable source", "Back to sources"]);
        await writeSources(root, [sourceC, sourceA, sourceB, sourceD]);
        return "Disable source";
      },
      (_title, options) => {
        assert.deepEqual(options, [
          sourceLabel(sourceC, 0),
          sourceLabel({ ...sourceA, enabled: false }, 1),
          sourceLabel(sourceB, 2),
          sourceLabel(sourceD, 3),
        ]);
        return undefined;
      },
    ],
  });

  await menu.run();

  const finalSources = [sourceC, { ...sourceA, enabled: false }, sourceB, sourceD];
  assert.deepEqual(await readSources(root), finalSources);
  assert.deepEqual(callbackSnapshot, finalSources, "the callback runs after the change is saved");
  assert.match(menu.calls.notifications[0]?.message ?? "", /Disabled Shared/u);
});

test("an empty source list asks the agent to add sources and returns", async (t) => {
  const root = await temporaryRoot(t);
  await writeSources(root, []);
  const menu = commandHarness(root, { selections: ["anything"] });

  await menu.run();

  assert.equal(menu.calls.selections.length, 0);
  assert.match(menu.calls.notifications[0]?.message ?? "", /Ask your agent to add/u);
  assert.deepEqual(await readSources(root), []);
});

test("cancelling either selector exits without changing sources", async (t) => {
  const root = await temporaryRoot(t);
  const initial = await readSources(root);
  const topCancel = commandHarness(root, { selections: [undefined] });

  await topCancel.run();

  assert.deepEqual(await readSources(root), initial);

  const actionCancel = commandHarness(root, {
    selections: [sourceLabel(initial[0], 0), undefined],
  });
  await actionCancel.run();

  assert.equal(actionCancel.calls.selections.length, 2);
  assert.deepEqual(await readSources(root), initial);
});

test("/source exits cleanly when Pi has no interactive UI", async (t) => {
  const root = await temporaryRoot(t);
  const menu = commandHarness(root, { hasUI: false });

  await menu.run();

  assert.equal(menu.calls.selections.length, 0);
  assert.equal(menu.calls.inputs.length, 0);
  assert.match(menu.calls.notifications[0]?.message ?? "", /interactive/u);
});
