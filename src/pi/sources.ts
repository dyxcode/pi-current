import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SourceRegistry } from "../sources/registry.ts";
import { collectAndSave } from "../sources/collection.ts";
import { dataRoot } from "../sources/paths.ts";
import { safeCode } from "../sources/types.ts";
import { SQLiteContentLibrary } from "../library/store.ts";
import type { ContentLibrary } from "../library/types.ts";
import { RequestAuthorization } from "./authorization.ts";
import { localResultSchema, receipt, registerLocalCards, statusLabel } from "./cards.ts";

export { localResultSchema } from "./cards.ts";

const sourceSchema = Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" });
const uuidSchema = Type.String({
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
});

export function registerSources(
  pi: ExtensionAPI,
  options: {
    root?: string;
    registry?: SourceRegistry;
    library?: ContentLibrary;
  } = {},
) {
  const root = options.root ?? dataRoot();
  let registry = options.registry ?? new SourceRegistry({ root });
  let library = options.library ?? new SQLiteContentLibrary(root);
  let generation = 0;
  let sessionAbort = new AbortController();
  const authorization = new RequestAuthorization();
  const { card, statusCard, itemCard } = registerLocalCards(pi);

  // Each operation keeps its original dependencies and cancellation signal.
  const operation = (caller?: AbortSignal) => ({
    generation,
    registry,
    library,
    signal: caller ? AbortSignal.any([caller, sessionAbort.signal]) : sessionAbort.signal,
  });
  const current = (run: ReturnType<typeof operation>) => {
    if (run.generation !== generation || run.signal.aborted) throw new Error("CANCELLED");
  };
  const transition = async (reopen: boolean) => {
    const revision = ++generation;
    authorization.clear();
    sessionAbort.abort();
    await Promise.allSettled([registry.close(), library.close()]);
    if (reopen && revision === generation) {
      registry = new SourceRegistry({ root });
      library = new SQLiteContentLibrary(root);
      sessionAbort = new AbortController();
    }
  };

  pi.on("input", (event) => {
    if (sessionAbort.signal.aborted) {
      authorization.clear();
      return;
    }
    const sourceRegistry = registry;
    return authorization.capture(event, () => sourceRegistry.list());
  });
  pi.on("agent_end", () => authorization.clear());
  pi.on("session_shutdown", () => transition(false));
  pi.on("session_start", () => transition(true));

  pi.registerCommand("sources", {
    description: "Register local source plugins and manage login. Never collects content.",
    async handler(_args, ctx) {
      authorization.clear();
      const run = operation();
      if (!ctx.hasUI) {
        ctx.ui.notify("/sources requires the interactive Pi UI.", "warning");
        return;
      }
      while (true) {
        try {
          current(run);
          const rows = await run.registry.list();
          current(run);
          const labels = rows.map(
            (source) =>
              `${source.name} [${source.id}] · ${source.enabled ? "Enabled" : "Disabled"} · ${statusLabel(source)}`,
          );
          const choice = await ctx.ui.select("Sources", [...labels, "Add source", "Back"]);
          current(run);
          if (!choice || choice === "Back") return;
          if (choice === "Add source") {
            const path = await ctx.ui.input(
              "Local plugin file — trusted executable code",
              "Absolute path to .mjs, .js or .ts",
            );
            current(run);
            if (path) {
              await run.registry.register(path.trim());
              current(run);
              ctx.ui.notify("Source registered. No login or collection started.", "info");
            }
            continue;
          }
          const row = rows[labels.indexOf(choice)];
          if (!row) continue;
          const actions = [
            ...(row.capabilities.login
              ? [row.auth === "not-connected" ? "Log in" : "Reconnect"]
              : []),
            ...(row.capabilities.check ? ["Check connection"] : []),
            row.enabled ? "Disable" : "Enable",
            "Remove source",
            "Back",
          ];
          const action = await ctx.ui.select(
            `${row.name} · Last checked: ${row.checkedAt ?? "never"}`,
            actions,
          );
          current(run);
          if (action === "Log in" || action === "Reconnect") {
            await run.registry.login(row.id, run.signal);
            current(run);
            ctx.ui.notify(
              "Complete login, then explicitly check the connection. No collection started.",
              "info",
            );
          } else if (action === "Check connection") {
            await run.registry.check(row.id, run.signal);
            current(run);
            const status = (await run.registry.list()).find((source) => source.id === row.id);
            current(run);
            if (status) statusCard(status);
          } else if (action === "Enable" || action === "Disable") {
            await run.registry.setEnabled(row.id, action === "Enable");
          } else if (action === "Remove source") {
            await run.registry.remove(row.id);
            current(run);
            ctx.ui.notify(
              "Registration removed. Credentials and saved content are retained.",
              "info",
            );
          }
        } catch (error) {
          if (run.generation !== generation || run.signal.aborted) return;
          ctx.ui.notify(safeCode(error), "error");
        }
      }
    },
  });

  pi.registerTool({
    name: "current_sources",
    label: "Sources · login and status",
    description:
      "List registered source IDs and cached status. Login/check require an explicit request naming the source. Use /sources to register or remove plugins; this tool cannot register code.",
    promptSnippet:
      "List cached source status, or log in/check a named source after an explicit request.",
    parameters: Type.Object(
      {
        action: StringEnum(["list", "login", "check"] as const),
        source: Type.Optional(sourceSchema),
      },
      { additionalProperties: false },
    ),
    outputSchema: localResultSchema,
    async execute(_id, args, signal) {
      const run = operation(signal);
      if (args.action !== "list") {
        if (!args.source) throw new Error("SOURCE_ACTION_NOT_REQUESTED");
        authorization.take(args.action, args.source);
        current(run);
        await run.registry[args.action](args.source, run.signal);
        current(run);
      }
      current(run);
      const rows = (await run.registry.list()).filter(
        (source) => !args.source || source.id === args.source,
      );
      current(run);
      rows.forEach(statusCard);
      return receipt(args.source ?? "all", rows.length, "Source status displayed.", {
        sources: rows.map((source) => ({
          id: source.id,
          name: source.name,
          status: statusLabel(source),
        })),
      });
    },
  });

  pi.registerTool({
    name: "current_feed_collect",
    label: "Collect source content · explicit request",
    description:
      "Collect once only after a direct request such as Collect 3 items from SOURCE_ID. Stop at the first error. No automatic retry, fallback, or resumption. Content stays local.",
    promptSnippet:
      "Fetch and save one bounded batch from a named source after an explicit collection request.",
    parameters: Type.Object(
      {
        source: sourceSchema,
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
      },
      { additionalProperties: false },
    ),
    outputSchema: localResultSchema,
    async execute(_id, args, signal) {
      const limit = args.limit ?? 5;
      authorization.take("collect", args.source, limit);
      const run = operation(signal);
      current(run);
      const outcome = await collectAndSave(
        run.registry,
        run.library,
        { sourceId: args.source, limit },
        run.signal,
      );
      current(run);
      const { batch, storage } = outcome;
      const saved = storage.status === "saved" ? storage.batch : undefined;
      (saved?.items ?? batch.items).forEach(itemCard);
      const message =
        storage.status === "saved"
          ? "Saved to the local library."
          : `Fetched but not confirmed saved: ${storage.code}.`;
      card(
        "Collection result",
        `${batch.items.length} items · Stop: ${batch.stopReason}\n${message}`,
      );
      const status = (await run.registry.list()).find((source) => source.id === args.source);
      current(run);
      if (status) statusCard(status);
      return receipt(args.source, batch.items.length, message, {
        status: batch.stopReason,
        references:
          saved?.items.map((value) => ({ itemId: value.itemId, versionId: value.versionId })) ?? [],
      });
    },
  });

  pi.registerTool({
    name: "current_feed_items",
    label: "Saved feed · offline",
    description:
      "Display the latest saved batch and cached connection status. Never checks login or fetches content. Private content is not supplied to the model.",
    promptSnippet:
      "Display the latest saved batches for enabled sources and cached status, entirely offline.",
    parameters: Type.Object(
      { source: Type.Optional(sourceSchema) },
      { additionalProperties: false },
    ),
    outputSchema: localResultSchema,
    async execute(_id, args, signal) {
      authorization.clear();
      const run = operation(signal);
      current(run);
      const rows = await run.registry.list();
      current(run);
      let count = 0;
      for (const row of rows.filter((source) => !args.source || source.id === args.source)) {
        current(run);
        statusCard(row);
        if (row.enabled) {
          const batch = await run.library.latest(row.id, run.signal);
          current(run);
          batch?.items.forEach(itemCard);
          count += batch?.items.length ?? 0;
        }
      }
      return receipt(args.source ?? "all", count, "Saved items displayed; no network requests.");
    },
  });

  pi.registerTool({
    name: "current_library_search",
    label: "Search saved content · offline",
    description:
      "Search the local library only, including disabled or removed sources. Returns opaque references; evidence appears only in local cards.",
    promptSnippet:
      "Search saved content offline, including removed sources; display matches locally and return item references.",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 200 }),
        source: Type.Optional(sourceSchema),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10 })),
      },
      { additionalProperties: false },
    ),
    outputSchema: localResultSchema,
    async execute(_id, args, signal) {
      authorization.clear();
      const run = operation(signal);
      current(run);
      const items = await run.library.search(args, run.signal);
      current(run);
      items.forEach(itemCard);
      return receipt(args.source ?? "all", items.length, "Local matches displayed.", {
        references: items.map((value) => ({ itemId: value.itemId, versionId: value.versionId })),
      });
    },
  });

  pi.registerTool({
    name: "current_library_read",
    label: "Read saved content · offline",
    description:
      "Read an item or older version from the local library. Does not refresh content or access a source plugin.",
    promptSnippet:
      "Display a saved item or version in local cards without fetching or refreshing its source.",
    parameters: Type.Object(
      {
        itemId: uuidSchema,
        versionId: Type.Optional(uuidSchema),
        maxCharacters: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000, default: 20000 })),
      },
      { additionalProperties: false },
    ),
    outputSchema: localResultSchema,
    async execute(_id, args, signal) {
      authorization.clear();
      const run = operation(signal);
      current(run);
      const item = await run.library.read(args, run.signal);
      current(run);
      if (item) itemCard(item);
      return receipt(
        item?.sourceId ?? "library",
        item ? 1 : 0,
        item ? "Saved item displayed." : "Item not found.",
        {
          references: item ? [{ itemId: item.itemId, versionId: item.versionId }] : [],
        },
      );
    },
  });

  pi.registerTool({
    name: "current_library_remove",
    label: "Remove saved item",
    description:
      "Delete one saved item only after an explicit request: Delete saved item ITEM_ID. Preserves plugin registration and credentials.",
    promptSnippet:
      "Delete one saved item and its versions after an explicit request naming its item ID.",
    parameters: Type.Object({ itemId: uuidSchema }, { additionalProperties: false }),
    outputSchema: localResultSchema,
    async execute(_id, args, signal) {
      authorization.takeRemove(args.itemId);
      const run = operation(signal);
      current(run);
      const removed = await run.library.remove(args.itemId, run.signal);
      current(run);
      return receipt(
        "library",
        removed ? 1 : 0,
        removed ? "Saved item deleted." : "Item already absent.",
      );
    },
  });

  return {
    async read(url: string, maxCharacters: number, signal?: AbortSignal, sourceId?: string) {
      const request = authorization.takeRead(url, sourceId);
      const run = operation(signal);
      current(run);
      const id = await run.registry.resolve(request.url, request.source);
      current(run);
      const item = await run.registry.read(id, request.url, maxCharacters, run.signal);
      current(run);
      itemCard(item);
      return receipt(id, 1, "Requested item displayed locally.");
    },
  };
}
