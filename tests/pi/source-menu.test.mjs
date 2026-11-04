import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function commandHarness(root, { selections = [], inputs = [], hasUI = true } = {}) {
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
      const choice = typeof next === "function" ? next(title, options) : next;
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
  registerSourceMenu(pi, root);

  return {
    calls,
    async run() {
      await commands.get("source").handler("", { hasUI, ui });
    },
  };
}

test("/source adds a name and feed URL without making a network request", async (t) => {
  const root = await temporaryRoot(t);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (...args) => {
    requests.push(args);
    throw new Error("The source menu must not fetch feeds");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const menu = commandHarness(root, {
    selections: [
      (title, options) => {
        assert.equal(title, "Reading sources");
        assert.ok(options.includes("Add source"));
        return "Add source";
      },
      undefined,
    ],
    inputs: [" Local Lab ", "HTTPS://Feeds.Example.test:443/lab.xml#section"],
  });

  await menu.run();

  assert.deepEqual((await readSources(root)).at(-1), {
    name: "Local Lab",
    url: "https://feeds.example.test/lab.xml",
    enabled: true,
  });
  assert.equal(menu.calls.inputs.length, 2);
  assert.deepEqual(requests, []);
});

test("/source lists duplicate names distinctly, toggles one source, then removes only that source", async (t) => {
  const root = await temporaryRoot(t);
  const sourceA = { name: "Shared", url: "https://feeds.example.test/a.xml", enabled: true };
  const sourceB = { name: "Shared", url: "https://feeds.example.test/b.xml", enabled: true };
  await writeSources(root, [sourceA, sourceB]);
  await writeFile(join(root, "content.sqlite"), "keep-library-data");
  const chooseA = (_title, options) => {
    const rows = options.filter((option) => option.includes(sourceA.url));
    assert.equal(rows.length, 1);
    return rows[0];
  };
  const menu = commandHarness(root, {
    selections: [
      (_title, options) => {
        const rows = options.filter((option) => option.includes("https://feeds.example.test/"));
        assert.equal(rows.length, 2);
        assert.notEqual(rows[0], rows[1], "same-name sources need unique selection labels");
        assert.ok(rows.every((row) => /enabled/i.test(row)));
        return chooseA(_title, options);
      },
      "Disable source",
      (_title, options) => {
        const rows = options.filter((option) => option.includes(sourceA.url));
        assert.equal(rows.length, 1);
        assert.match(rows[0], /disabled/i);
        return rows[0];
      },
      "Remove source",
      undefined,
    ],
  });

  await menu.run();

  assert.deepEqual(await readSources(root), [sourceB]);
  assert.equal(await readFile(join(root, "content.sqlite"), "utf8"), "keep-library-data");
});

test("cancelling the selector or an add prompt exits without changing sources", async (t) => {
  const root = await temporaryRoot(t);
  const initial = await readSources(root);
  const topCancel = commandHarness(root, { selections: [undefined] });

  await topCancel.run();

  assert.deepEqual(await readSources(root), initial);
  assert.equal(topCancel.calls.inputs.length, 0);

  const inputCancel = commandHarness(root, {
    selections: ["Add source"],
    inputs: ["Incomplete source", undefined],
  });
  await inputCancel.run();

  assert.equal(inputCancel.calls.selections.length, 1, "input cancellation exits the menu");
  assert.deepEqual(await readSources(root), initial);
});

test("a duplicate feed URL entered in the menu reports a useful error and saves nothing", async (t) => {
  const root = await temporaryRoot(t);
  const menu = commandHarness(root, {
    selections: ["Add source", undefined],
    inputs: ["Duplicate", "HTTPS://NEWS.MIT.EDU:443/rss/research#tag"],
  });

  await menu.run();

  assert.match(menu.calls.notifications[0]?.message ?? "", /duplicate.*(feed )?URL/i);
  assert.deepEqual(
    (await readSources(root)).map(({ name }) => name),
    ["MIT Research", "JSTOR Daily", "Psyche"],
  );
});

test("/source exits cleanly when Pi has no interactive UI", async (t) => {
  const root = await temporaryRoot(t);
  const menu = commandHarness(root, { hasUI: false });

  await menu.run();

  assert.equal(menu.calls.selections.length, 0);
  assert.equal(menu.calls.inputs.length, 0);
  assert.match(menu.calls.notifications[0]?.message ?? "", /interactive/i);
});
