import { createHash, randomUUID } from "node:crypto";
import type { ContentLibrary, LibraryBatch, LibraryContent } from "../library/types.ts";
import { answer } from "../library/validation.mjs";
import { ReadError } from "../web/read-types.ts";
import { fetchFeed as readFeed } from "./feed.ts";
import type { SourceEntry, SourceFetchResult, SourceInput, SourceIssue } from "./types.ts";

const fetchTimeoutMs = 30_000;
const maxMetadataCharacters = 4_096;
const maxUrlCharacters = 8_192;

export type ImportInput = { url: string; limit?: number };
export type ImportResult = { sourceId: string; batch: LibraryBatch; issues: SourceIssue[] };

/** Canonicalize a configured feed URL using the same rules as direct import. */
export function normalizeFeedUrl(value: string): string {
  if (typeof value !== "string" || value.length > maxUrlCharacters) {
    throw new Error("Invalid source input: url must be an HTTP or HTTPS URL.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid source input: url must be an HTTP or HTTPS URL.");
  }
  if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password) {
    throw new Error("Invalid source input: url must be an HTTP or HTTPS URL without credentials.");
  }
  url.hash = "";
  if (url.href.length > maxUrlCharacters) {
    throw new Error("Invalid source input: normalized url exceeds 8,192 characters.");
  }
  if (JSON.stringify({ sourceUrl: url.href }).length > maxMetadataCharacters) {
    throw new Error(
      "Invalid source input: configured URL provenance exceeds the library metadata limit.",
    );
  }
  return url.href;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeImportInput(value: ImportInput): SourceInput {
  if (!isRecord(value)) {
    throw new Error("Invalid source input: expected an object with url and optional limit.");
  }
  const limit = value.limit === undefined ? 5 : value.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("Invalid source input: limit must be an integer from 1 to 10.");
  }
  return { url: normalizeFeedUrl(value.url), limit };
}

export function sourceIdFor(url: string): string {
  const digest = createHash("sha256").update(`feed\0${url}`).digest("hex").slice(0, 40);
  return `feed-${digest}`;
}

function withFeedIdentity(entry: SourceEntry, sourceId: string, sourceUrl: string): LibraryContent {
  const metadata: Record<string, string | number | boolean | null> = {
    ...entry.metadata,
    sourceUrl,
  };
  if (metadata.feedUrl === sourceUrl) delete metadata.feedUrl;
  if (JSON.stringify(metadata).length > maxMetadataCharacters) {
    throw new Error("Feed entry metadata exceeds the 4,096-character library limit.");
  }
  const result = {
    ...entry,
    sourceId,
    metadata,
  };
  answer(result);
  return result;
}

export function prepareFeedEntries(
  fetched: SourceFetchResult,
  sourceId: string,
  sourceUrl: string,
): { items: LibraryContent[]; issues: SourceIssue[] } {
  const issues = [...fetched.issues];
  const items: LibraryContent[] = [];
  for (const [index, entry] of fetched.items.entries()) {
    const observedPosition = entry.observedPosition;
    const issueIndex =
      typeof observedPosition === "number" &&
      Number.isInteger(observedPosition) &&
      observedPosition >= 1
        ? observedPosition - 1
        : index;
    try {
      items.push(withFeedIdentity(entry, sourceId, sourceUrl));
    } catch (error) {
      issues.push({
        index: issueIndex,
        message:
          error instanceof Error &&
          error.message === "Feed entry metadata exceeds the 4,096-character library limit."
            ? error.message
            : "Invalid feed entry was skipped.",
      });
    }
  }
  issues.sort((left, right) => left.index - right.index);
  return { items, issues };
}

/** Fetch one feed with the shared acquisition deadline and caller cancellation. */
export async function fetchFeedWithDeadline(
  input: SourceInput,
  signal?: AbortSignal,
): Promise<SourceFetchResult> {
  if (signal?.aborted) throw new Error("CANCELLED");
  const fetchSignal = AbortSignal.any([
    AbortSignal.timeout(fetchTimeoutMs),
    ...(signal ? [signal] : []),
  ]);
  try {
    return await readFeed(input, fetchSignal);
  } catch (error) {
    if (signal?.aborted) throw new Error("CANCELLED", { cause: error });
    const reason = fetchSignal.reason;
    if (fetchSignal.aborted && reason instanceof DOMException && reason.name === "TimeoutError") {
      throw new ReadError("TIMEOUT", `Feed retrieval exceeded its ${fetchTimeoutMs} ms deadline.`);
    }
    throw error;
  }
}

/** Save a prepared feed batch through the library, preserving the source identity. */
export async function saveFeedBatch(
  library: Pick<ContentLibrary, "save">,
  input: {
    sourceId: string;
    requestedCount: number;
    startedAt: string;
    items: LibraryContent[];
    issues: SourceIssue[];
    stopReason: string;
  },
  signal?: AbortSignal,
): Promise<LibraryBatch> {
  const firstIssue = input.issues[0];
  return library.save(
    {
      requestedCount: input.requestedCount,
      startedAt: input.startedAt,
      batch: {
        id: randomUUID(),
        sourceId: input.sourceId,
        collectedAt: new Date().toISOString(),
        items: input.items,
        failures: firstIssue
          ? [{ externalId: String(firstIssue.index), code: "SOURCE_ISSUE" }]
          : [],
        stopReason: input.stopReason,
      },
    },
    signal,
  );
}

/** Fetch the built-in feed once and save its valid entries through the library API. */
export async function importFeed(
  library: Pick<ContentLibrary, "save">,
  inputValue: ImportInput,
  signal?: AbortSignal,
): Promise<ImportResult> {
  const input = normalizeImportInput(inputValue);
  if (signal?.aborted) throw new Error("CANCELLED");

  const sourceId = sourceIdFor(input.url);
  const startedAt = new Date().toISOString();
  const fetched = await fetchFeedWithDeadline(input, signal);
  if (signal?.aborted) throw new Error("CANCELLED");

  const { items, issues } = prepareFeedEntries(fetched, sourceId, input.url);
  if (signal?.aborted) throw new Error("CANCELLED");

  const batch = await saveFeedBatch(
    library,
    {
      sourceId,
      requestedCount: input.limit,
      startedAt,
      items,
      issues,
      stopReason:
        items.length >= input.limit ? "limit" : issues.length > 0 ? "partial" : "complete",
    },
    signal,
  );
  if (signal?.aborted) throw new Error("CANCELLED");
  return { sourceId, batch, issues };
}
