import { isAbsolute } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { SQLiteContentLibrary } from "../library/store.ts";
import type { ContentLibrary, LibraryItem } from "../library/types.ts";
import { MAX_ARTICLE_BYTES } from "../sources/content-limits.mjs";
import { importSource } from "../sources/import.ts";
import { dataRoot } from "../sources/paths.ts";
import { SourceRegistry } from "../sources/registry.ts";
import type { SourceIssue } from "../sources/types.ts";
import { localResultSchema, receipt, registerLocalCards, cleanDisplayText } from "./cards.ts";
import { openLocalReader } from "./reader.ts";

const itemIdSchema = Type.String({
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
});
const sourceIdSchema = Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" });
const importArgumentsSchema = Type.Object(
  {
    url: Type.String({ minLength: 1, maxLength: 8192 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
    module: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$", default: "feed" })),
  },
  { additionalProperties: false },
);

const sourcesResultSchema = Type.Object(
  {
    sources: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          name: Type.String(),
          kind: StringEnum(["built-in", "external"] as const),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type ImportArguments = { url: string; limit: number; module: string };
type Operation = { controller: AbortController; signal: AbortSignal };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateImportArguments(value: unknown): ImportArguments {
  if (!record(value) || Object.keys(value).some((key) => !["url", "limit", "module"].includes(key)))
    throw new Error("Invalid source import arguments.");
  const url = value.url;
  const limit = value.limit ?? 5;
  const module = value.module ?? "feed";
  if (
    typeof url !== "string" ||
    !url.trim() ||
    url.length > 8192 ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10 ||
    typeof module !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(module)
  ) {
    throw new Error("Provide an HTTP(S) URL, a registered module, and a limit from 1 to 10.");
  }
  return { url: url.trim(), limit, module };
}

function localIssueLines(issues: SourceIssue[]) {
  return issues.slice(0, 20).map(({ index, message }) => {
    const excerpt = Array.from(cleanDisplayText(message)).slice(0, 200).join("");
    return `Entry ${index}: ${excerpt}`;
  });
}

function issueIndexesFor(issues: SourceIssue[]) {
  return issues.slice(0, 20).map(({ index }) => index);
}

function savedReferences(items: LibraryItem[]) {
  return items.slice(0, 20).map(({ itemId, versionId }) => ({ itemId, versionId }));
}

export function registerSources(
  pi: ExtensionAPI,
  options: { root?: string; registry?: SourceRegistry; library?: ContentLibrary } = {},
): void {
  const root = options.root ?? dataRoot();
  const registry = options.registry ?? new SourceRegistry({ root });
  const library = options.library ?? new SQLiteContentLibrary(root);
  const { card, itemCard } = registerLocalCards(pi);
  let sessionController = new AbortController();

  const operation = (caller?: AbortSignal): Operation => ({
    controller: sessionController,
    signal: caller ? AbortSignal.any([caller, sessionController.signal]) : sessionController.signal,
  });
  const current = (run: Operation) => {
    if (run.signal.aborted || run.controller !== sessionController) throw new Error("CANCELLED");
  };

  pi.on("session_start", () => {
    sessionController.abort();
    sessionController = new AbortController();
  });
  pi.on("session_shutdown", () => sessionController.abort());

  pi.registerCommand("sources", {
    description: "List, add, and remove local source modules.",
    async handler(_args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify("/sources requires an interactive Pi UI.", "warning");
        return;
      }
      const run = operation();
      while (!run.signal.aborted) {
        try {
          const rows = await registry.list();
          current(run);
          const sourceChoices = rows.map((source) => ({
            source,
            label: `${source.name} [${source.id}] · ${source.modulePath === undefined ? "Built-in" : "External"}`,
          }));
          const labels = sourceChoices.map(({ label }) => label);
          const choice = await ctx.ui.select("Sources", [...labels, "Add module", "Back"]);
          current(run);
          if (!choice || choice === "Back") return;
          if (choice === "Add module") {
            const modulePath = (
              await ctx.ui.input("Absolute path to a local source module")
            )?.trim();
            current(run);
            if (!modulePath) continue;
            if (!isAbsolute(modulePath)) {
              ctx.ui.notify("Source module paths must be absolute.", "warning");
              continue;
            }
            try {
              await registry.register(modulePath);
              current(run);
              ctx.ui.notify("Source module added.", "info");
            } catch (error) {
              current(run);
              ctx.ui.notify(`Could not add source module: ${safeError(error)}`, "error");
            }
            continue;
          }

          const source = sourceChoices.find(({ label }) => label === choice)?.source;
          if (!source) continue;
          if (source.modulePath === undefined) {
            ctx.ui.notify("The built-in feed module is always available.", "info");
            continue;
          }
          const action = await ctx.ui.select(`${source.name} [${source.id}]`, [
            "Remove module",
            "Back",
          ]);
          current(run);
          if (action === "Remove module") {
            await registry.remove(source.id);
            current(run);
            ctx.ui.notify("Source module removed. Saved library items were kept.", "info");
          }
        } catch (error) {
          if (run.signal.aborted) return;
          ctx.ui.notify(`Could not list source modules: ${safeError(error)}`, "error");
          return;
        }
      }
    },
  });

  pi.registerTool({
    name: "current_sources",
    label: "List local sources",
    description: "List the built-in feed importer and locally registered source modules.",
    promptSnippet: "List locally registered content import modules.",
    promptGuidelines: [
      "Use this only to inspect source modules; it does not access feeds or fetch content.",
    ],
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: sourcesResultSchema,
    async execute(_toolCallId, _params, signal) {
      const run = operation(signal);
      const rows = await registry.list();
      current(run);
      const sources = rows.map((source) => ({
        id: source.id,
        name: source.name,
        kind: source.modulePath === undefined ? "built-in" : "external",
      }));
      const result = { sources };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "current_source_import",
    label: "Import and save feed content",
    description:
      "Fetch and save readable content from one registered local source module. Article bodies stay in the local library; the result contains references and issue indexes only.",
    promptSnippet: "Fetch and save requested content from a local source module.",
    promptGuidelines: [
      "Use only for a direct user request to import or fetch content from a supplied source URL. Do not use it for recommendations or inferred interests.",
      "This call fetches and saves once. It does not create a subscription or refresh schedule.",
      "Article bodies and detailed source issue messages remain local. Report only references and issue indexes; do not claim to have read or summarized the saved body.",
    ],
    parameters: importArgumentsSchema,
    prepareArguments: validateImportArguments,
    outputSchema: localResultSchema,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx: ExtensionToolContext) {
      const params = validateImportArguments(rawParams);
      const run = operation(signal);
      let sourceName = params.module;
      let imported: Awaited<ReturnType<typeof importSource>>;
      try {
        const module = await registry.get(params.module);
        sourceName = module.name;
        current(run);
        imported = await importSource(module, library, params, run.signal);
        current(run);
      } catch (error) {
        current(run);
        const message = safeError(error);
        if (ctx.hasUI) ctx.ui.notify(`${sourceName} import failed: ${message}`, "error");
        return receipt(
          params.module,
          0,
          ctx.hasUI
            ? "Source import failed. See the local error for details."
            : "Source import failed.",
          { status: "failed" },
        );
      }
      let cardFailure: unknown;
      for (const item of imported.batch.items) {
        try {
          itemCard(item);
        } catch (error) {
          cardFailure = error;
          break;
        }
      }
      if (cardFailure !== undefined && ctx.hasUI)
        ctx.ui.notify(
          `Items were saved, but a local card failed: ${safeError(cardFailure)}`,
          "warning",
        );
      const issueIndexes = issueIndexesFor(imported.issues);
      if (imported.issues.length) {
        try {
          card("Source import issues", localIssueLines(imported.issues).join("\n"));
        } catch (error) {
          cardFailure ??= error;
        }
      }
      const status = issueIndexes.length ? "partial" : "saved";
      const message =
        cardFailure !== undefined
          ? `Saved ${imported.batch.items.length} item(s), but a local card could not be shown.`
          : issueIndexes.length
            ? `Saved ${imported.batch.items.length} item(s) to the local library. Detailed entry issues are available in a local card.`
            : `Saved ${imported.batch.items.length} item(s) to the local library.`;
      return receipt(imported.sourceId, imported.batch.items.length, message, {
        status,
        references: savedReferences(imported.batch.items),
        ...(issueIndexes.length ? { issueIndexes } : {}),
      });
    },
  });

  pi.registerTool({
    name: "current_library_search",
    label: "Search local library",
    description:
      "Search saved local titles, summaries, and article bodies offline. Returns references; local cards show only a short preview.",
    promptSnippet: "Search the offline local content library and show short local previews.",
    promptGuidelines: [
      "Use this for explicit searches of saved local content. Do not expand a library-only request to the public web.",
      "The model receives references only. Use current_library_read only when the user explicitly asks to open a saved item in the local reader.",
    ],
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 200 }),
        source: Type.Optional(sourceIdSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10 })),
      },
      { additionalProperties: false },
    ),
    outputSchema: localResultSchema,
    async execute(_toolCallId, params, signal) {
      const run = operation(signal);
      const rows = await library.search(
        {
          query: params.query,
          ...(params.source ? { source: params.source } : {}),
          limit: params.limit ?? 10,
        },
        run.signal,
      );
      current(run);
      for (const item of rows) itemCard(item);
      const references = savedReferences(rows);
      return receipt(
        "library",
        rows.length,
        `Found ${rows.length} matching saved item(s). Local cards contain previews only.`,
        { status: "found", references },
      );
    },
  });

  pi.registerTool({
    name: "current_library_read",
    label: "Open saved item locally",
    description:
      "Load a saved article body from the local library and display it in Pi's scrollable local reader. The article body is never returned to the model.",
    promptSnippet: "Open an explicitly requested saved item in the local reader.",
    promptGuidelines: [
      "Use this only when the user explicitly asks to open or read a saved item and provides its item reference.",
      "The body appears in the local Pi reader only. Never summarize or quote a body the model did not receive.",
    ],
    parameters: Type.Object(
      {
        itemId: itemIdSchema,
        versionId: Type.Optional(itemIdSchema),
      },
      { additionalProperties: false },
    ),
    outputSchema: localResultSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) {
      const run = operation(signal);
      const item = await library.read(
        {
          itemId: params.itemId,
          ...(params.versionId ? { versionId: params.versionId } : {}),
          maxCharacters: MAX_ARTICLE_BYTES,
        },
        run.signal,
      );
      current(run);
      if (!item)
        return receipt("library", 0, "The saved item was not found.", { status: "not-found" });
      const reference = { itemId: item.itemId, versionId: item.versionId };
      if (typeof item.text !== "string") {
        if (ctx.mode !== "tui" || !ctx.hasUI)
          return receipt(
            "library",
            1,
            "No interactive TUI was available; this item has no stored article body and remains unread.",
            { status: "unread", references: [reference] },
          );
        itemCard(item);
        return receipt(
          "library",
          1,
          "This saved item has no article body; a local candidate card was shown.",
          {
            status: "candidate",
            references: [reference],
          },
        );
      }
      const displayed = await openLocalReader(ctx, item, run.signal);
      current(run);
      if (!displayed)
        return receipt(
          "library",
          1,
          "No interactive TUI reader was available; the item remains unread.",
          {
            status: "unread",
            references: [reference],
          },
        );
      return receipt("library", 1, "The saved article was displayed in the local Pi reader.", {
        status: "displayed",
        references: [reference],
      });
    },
  });

  pi.registerTool({
    name: "current_library_remove",
    label: "Remove saved item",
    description:
      "Permanently remove one saved item and its stored versions from the local library.",
    promptSnippet: "Remove a saved local item when the user explicitly requests deletion.",
    promptGuidelines: [
      "Call this only for a direct user request to delete a saved item. Do not delete items as cleanup or to resolve a source-module problem.",
      "Use an item ID returned by a local library tool; deleting a saved item does not remove its source module.",
    ],
    parameters: Type.Object({ itemId: itemIdSchema }, { additionalProperties: false }),
    outputSchema: localResultSchema,
    async execute(_toolCallId, params, signal) {
      const run = operation(signal);
      const removed = await library.remove(params.itemId, run.signal);
      current(run);
      return receipt(
        "library",
        removed ? 1 : 0,
        removed
          ? "The saved item was removed from the local library."
          : "The saved item was not found.",
        { status: removed ? "removed" : "not-found" },
      );
    },
  });
}

function safeError(error: unknown): string {
  if (!(error instanceof Error)) return "unexpected error";
  return Array.from(cleanDisplayText(error.message)).slice(0, 200).join("");
}
