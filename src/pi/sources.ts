import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { SQLiteContentLibrary } from "../library/store.ts";
import type { ContentLibrary, LibraryItem } from "../library/types.ts";
import { MAX_ARTICLE_BYTES } from "../sources/content-limits.mjs";
import { importFeed } from "../sources/import.ts";
import { dataRoot } from "../sources/paths.ts";
import type { SourceIssue } from "../sources/types.ts";
import { localResultSchema, receipt, registerLocalCards, cleanDisplayText } from "./cards.ts";
import { openLocalReader } from "./reader.ts";

const itemIdSchema = Type.String({
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
});
const sourceIdSchema = Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" });
const importArgumentsSchema = Type.Object(
  {
    url: Type.String({ description: "RSS or Atom feed URL for the current task." }),
    limit: Type.Optional(
      Type.Integer({ description: "Maximum entries to save, from 1 to 10. Defaults to 5." }),
    ),
  },
  { additionalProperties: false },
);

type Operation = { controller: AbortController; signal: AbortSignal };

function localIssueLines(issues: SourceIssue[]) {
  return issues.slice(0, 20).map(({ index, message }) => `Entry ${index}: ${message}`);
}

function savedReferences(items: LibraryItem[]) {
  return items.slice(0, 20).map(({ itemId, versionId }) => ({ itemId, versionId }));
}

export function registerSources(
  pi: ExtensionAPI,
  options: { root?: string; library?: ContentLibrary } = {},
): void {
  const root = options.root ?? dataRoot();
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

  pi.registerTool({
    name: "current_source_import",
    label: "Import and save feed content",
    description:
      "Fetch and save items from one RSS or Atom feed that serves the user's current task. The agent may choose a relevant feed URL when it helps fulfill the request.",
    promptSnippet:
      "Import one RSS or Atom feed to save feed-provided content for the current task.",
    promptGuidelines: [
      "Use when a current user request calls for feed content; choose an RSS or Atom feed URL when that helps fulfill the user's current reading or retrieval task.",
      "Keep library-only requests offline. This call fetches and saves once; it does not create a subscription or refresh schedule.",
      "Article bodies remain local. The receipt may include bounded feed-entry issue messages, but never the saved article body.",
    ],
    parameters: importArgumentsSchema,
    outputSchema: localResultSchema,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx: ExtensionToolContext) {
      const run = operation(signal);
      let imported: Awaited<ReturnType<typeof importFeed>>;
      try {
        imported = await importFeed(library, rawParams, run.signal);
        current(run);
      } catch (error) {
        current(run);
        const message = safeError(error);
        const detail = `Feed import failed: ${message}`;
        if (ctx.hasUI) ctx.ui.notify(detail, "error");
        return receipt("feed", 0, detail, { status: "failed" });
      }
      let cardFailure: unknown;
      try {
        for (const item of imported.batch.items) {
          itemCard(item);
        }
        if (imported.issues.length) {
          card("Source import issues", localIssueLines(imported.issues).join("\n"));
        }
      } catch (error) {
        cardFailure = error;
      }
      const issues = imported.issues;
      const hasIssues = issues.length > 0;
      const count = imported.batch.items.length;
      if (cardFailure !== undefined && ctx.hasUI)
        ctx.ui.notify(
          `Saved ${count} item(s), but a local card could not be shown: ${safeError(cardFailure)}`,
          "warning",
        );
      const message =
        cardFailure !== undefined
          ? `Saved ${count} item(s), but a local card could not be shown: ${safeError(cardFailure)}`
          : hasIssues
            ? `Saved ${count} item(s) to the local library. Feed entry issues are included in this receipt and a local card.`
            : `Saved ${count} item(s) to the local library.`;
      return receipt(imported.sourceId, count, message, {
        status: hasIssues ? "partial" : "saved",
        references: savedReferences(imported.batch.items),
        ...(hasIssues ? { issues } : {}),
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
      "Call this only for a direct user request to delete a saved item. Do not delete items as cleanup.",
      "Use an item ID returned by a local library tool; this removes that saved item and its versions only.",
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
