import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContentLibrary } from "../library/types.ts";
import type { SourceRegistry } from "../sources/registry.ts";
import type { Batch, SourceDiscovery, SourceItem } from "../sources/types.ts";
import { receipt, localResultSchema } from "./cards.ts";
import type { RequestAuthorization } from "./authorization.ts";

type Snapshot = {
  generation: number;
  registry: SourceRegistry;
  library: ContentLibrary;
  signal: AbortSignal;
};
type Options = {
  snapshot(signal?: AbortSignal): Snapshot;
  current(run: Snapshot): void;
  authorization: RequestAuthorization;
  card(title: string, body: string): void;
  itemCard(item: SourceItem): void;
  discoveryCard(item: SourceDiscovery): void;
};
const sourceId = Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" });
const reference = Type.String({ pattern: "^[a-f0-9-]{36}$" });

export function registerSourceOperations(pi: ExtensionAPI, options: Options) {
  const pending = new Map<string, { batch: Batch; requestedCount: number; startedAt: string }>();
  let latestRef: string | undefined;
  const remember = (batch: Batch, requestedCount: number, startedAt: string): string => {
    pending.set(batch.id, { batch: structuredClone(batch), requestedCount, startedAt });
    while (pending.size > 10) {
      const oldest = pending.keys().next().value;
      if (oldest) pending.delete(oldest);
    }
    latestRef = batch.id;
    return batch.id;
  };
  const bodyBatch = (
    source: string,
    items: SourceItem[],
    failures: Batch["failures"] = [],
    stopReason = "complete",
  ): Batch => ({
    id: randomUUID(),
    sourceId: source,
    collectedAt: new Date().toISOString(),
    items,
    failures,
    stopReason,
  });
  const save = async (pendingRef: string, run: Snapshot) => {
    options.current(run);
    const retained = pending.get(pendingRef);
    if (!retained) throw new Error("SOURCE_PENDING_NOT_FOUND");
    const original = retained.batch;
    try {
      const saved = await run.library.save(
        { batch: original, requestedCount: retained.requestedCount, startedAt: retained.startedAt },
        run.signal,
      );
      options.current(run);
      pending.delete(pendingRef);
      if (latestRef === pendingRef) latestRef = undefined;
      return receipt(original.sourceId, saved.items.length, "Saved to the local library.", {
        status: original.failures.length ? original.stopReason : "saved",
        references: saved.items.map((item) => ({ itemId: item.itemId, versionId: item.versionId })),
      });
    } catch (error) {
      options.current(run);
      const code =
        error instanceof Error && /^LIBRARY_[A-Z_]{1,40}$/.test(error.message)
          ? error.message
          : "LIBRARY_STORAGE_ERROR";
      options.card(
        "Save result",
        `Save not confirmed: ${code}. Fetched content remains available locally.`,
      );
      return receipt(
        original.sourceId,
        original.items.length,
        "Save was not confirmed; no content was fetched again.",
        {
          status: "save-unconfirmed",
          pendingRef,
        },
      );
    }
  };

  pi.registerTool({
    name: "current_source_operation",
    label: "Source discovery and reading · explicit request",
    description:
      "Run one declared source operation after a direct request naming its entry point, query/URL and count. List operations never read details or save. Fetch operations have a bounded request budget. Use save only when requested. Never retry after failure.",
    promptSnippet:
      "Discover or fetch a bounded batch from a source's declared operation after an explicit matching request.",
    promptGuidelines: [
      "Use exact user query text. Private discovery and article evidence stays in local cards; do not rank unseen results.",
      "Examples: Search SOURCE for QUERY limit 3; Fetch 3 items from SOURCE search: QUERY; Show 3 hot-list items from SOURCE; Fetch and save 3 recommendations from SOURCE; Read own URL from SOURCE.",
    ],
    parameters: Type.Object(
      {
        source: sourceId,
        operation: sourceId,
        query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        url: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
        maxRequests: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        maxCharacters: Type.Optional(
          Type.Integer({
            minimum: 1000,
            maximum: 50000,
            description: "Excerpt preference only; saved article bodies are retained in full.",
          }),
        ),
        save: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    outputSchema: localResultSchema,
    async execute(_id, args, signal) {
      const grant = options.authorization.takeOperation(args);
      const run = options.snapshot(signal);
      options.current(run);
      const startedAt = new Date().toISOString();
      const result = await run.registry.perform(
        args.source,
        args.operation,
        grant.request,
        run.signal,
      );
      options.current(run);
      if (result.kind === "discovery") {
        result.batch.items.forEach(options.discoveryCard);
        options.card(
          "Discovery result",
          `${result.batch.items.length} items · Stop: ${result.batch.stopReason}. Details were not requested.`,
        );
        return receipt(
          args.source,
          result.batch.items.length,
          "Discovery results displayed locally.",
          { status: result.batch.stopReason },
        );
      }
      result.batch.items.forEach(options.itemCard);
      options.card(
        "Read result",
        `${result.batch.items.length} items · Stop: ${result.batch.stopReason}.`,
      );
      if (!result.batch.items.length)
        return receipt(args.source, 0, "No readable items returned.", {
          status: result.batch.stopReason,
        });
      const batch = bodyBatch(
        args.source,
        result.batch.items,
        result.batch.failures,
        result.batch.stopReason,
      );
      const pendingRef = remember(batch, grant.request.limit, startedAt);
      if (grant.save) return save(pendingRef, run);
      options.card("Fetched content", `Not saved. To retain it: Save fetched batch ${pendingRef}`);
      return receipt(
        args.source,
        batch.items.length,
        "Requested content displayed locally; not saved.",
        { status: batch.stopReason, pendingRef },
      );
    },
  });

  pi.registerTool({
    name: "current_source_save",
    label: "Save fetched content · offline",
    description:
      "Save a previously fetched local batch after an explicit Save fetched batch REFERENCE or Save last fetched content request. Never accesses a source or refetches a body.",
    promptSnippet:
      "Save already fetched content by its opaque pending reference after an explicit save request, without network access.",
    parameters: Type.Object({ pendingRef: reference }, { additionalProperties: false }),
    outputSchema: localResultSchema,
    async execute(_id, args, signal) {
      options.authorization.takeSave(args.pendingRef);
      return save(args.pendingRef, options.snapshot(signal));
    },
  });
  return {
    get latestRef() {
      return latestRef;
    },
    clear() {
      pending.clear();
      latestRef = undefined;
    },
    rememberItem(item: SourceItem, startedAt: string) {
      return remember(bodyBatch(item.sourceId, [item]), 1, startedAt);
    },
  };
}
