import { randomUUID } from "node:crypto";
import type { ContentLibrary, LibraryBatch } from "../library/types.ts";
import type { SourceRegistry } from "./registry.ts";
import { validId, type Batch } from "./types.ts";

export type CollectionOutcome = {
  batch: Batch;
  storage: { status: "saved"; batch: LibraryBatch } | { status: "unconfirmed"; code: string };
};

const storageCodes = new Set([
  "LIBRARY_BUSY",
  "LIBRARY_CANCELLED",
  "LIBRARY_CLOSED",
  "LIBRARY_CONFLICT",
  "LIBRARY_INVALID",
  "LIBRARY_PATH",
  "LIBRARY_SCHEMA",
  "LIBRARY_STORAGE_ERROR",
  "LIBRARY_TIMEOUT",
  "LIBRARY_WRITE_UNCERTAIN",
]);

function active(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("CANCELLED");
}

/** Acquire one batch and retain its acquisition and persistence outcomes separately. */
export async function collectAndSave(
  collector: Pick<SourceRegistry, "collect">,
  library: Pick<ContentLibrary, "save">,
  request: { sourceId: string; limit: number },
  signal?: AbortSignal,
): Promise<CollectionOutcome> {
  validId(request.sourceId);
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 10) {
    throw new Error("SOURCE_INVALID_INPUT");
  }
  active(signal);
  const startedAt = new Date().toISOString();
  const acquired = await collector.collect(request.sourceId, request.limit, signal);
  active(signal);
  const batch: Batch = {
    ...acquired,
    id: randomUUID(),
    sourceId: request.sourceId,
    collectedAt: new Date().toISOString(),
  };
  try {
    const saved = await library.save({ requestedCount: request.limit, startedAt, batch }, signal);
    active(signal);
    return { batch, storage: { status: "saved", batch: saved } };
  } catch (error) {
    active(signal);
    const code =
      error instanceof Error && storageCodes.has(error.message)
        ? error.message
        : "LIBRARY_STORAGE_ERROR";
    return { batch, storage: { status: "unconfirmed", code } };
  }
}
