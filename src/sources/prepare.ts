import { randomUUID } from "node:crypto";
import type {
  ContentLibrary,
  LibraryBatch,
  LibraryContent,
  PreparedSource,
  SaveRequest,
} from "../library/types.ts";
import {
  fetchFeedWithDeadline,
  normalizeFeedUrl,
  prepareFeedEntries,
  sourceIdFor,
} from "./import.ts";
import type { ReadingSource } from "../reading/sources.ts";
import type { SourceFetchResult, SourceInput, SourceIssue } from "./types.ts";

const maxConcurrentFeeds = 3;

export type PreparationResult = {
  feeds: {
    source: ReadingSource;
    batch?: LibraryBatch;
    issues: string[];
    attemptedAt: string;
  }[];
  enabledSources: number;
  refreshed: number;
  processed: number;
};

type PreparedFeed = PreparationResult["feeds"][number];
type PreparedLibrary = Pick<ContentLibrary, "prepare" | "prepared">;

function sourceError(error: unknown): string {
  return error instanceof Error ? error.message : "Feed retrieval failed.";
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && /^(?:CANCELLED|LIBRARY_CANCELLED)(?:\b|:)/.test(error.message))
  );
}

function cancel(error?: unknown): Error {
  return new Error("CANCELLED", error === undefined ? undefined : { cause: error });
}

function entryIssueStrings(issues: SourceIssue[]): string[] {
  return issues.map(({ index, message }) => `Entry ${index + 1}: ${message}`);
}

function issuesAfterFailure(prepared: PreparedSource): string[] {
  const issues = [...prepared.issues];
  const successfulAt = prepared.batch?.collectedAt;
  if (successfulAt)
    issues.push(`Using the previous successful feed snapshot from ${successfulAt}.`);
  return issues;
}

function previousSnapshotIssue(batch: LibraryBatch | undefined): string[] {
  return batch ? [`Using the previous successful feed snapshot from ${batch.collectedAt}.`] : [];
}

function partialSnapshotIssues(prepared: PreparedSource | undefined): string[] {
  const known = prepared?.issues.filter((issue) => /^Entry \d+:/u.test(issue)) ?? [];
  if (known.length > 0) return known;
  return prepared?.batch?.failures.some(({ code }) => code === "SOURCE_ISSUE")
    ? ["The saved feed snapshot contains one or more entry issues."]
    : [];
}

function saveRequest(
  sourceId: string,
  attemptedAt: string,
  items: LibraryContent[],
  issues: SourceIssue[],
): SaveRequest {
  const firstIssue = issues[0];
  return {
    requestedCount: items.length,
    startedAt: attemptedAt,
    batch: {
      id: randomUUID(),
      sourceId,
      collectedAt: attemptedAt,
      items,
      failures: firstIssue ? [{ externalId: String(firstIssue.index), code: "SOURCE_ISSUE" }] : [],
      stopReason: issues.length > 0 ? "partial" : "complete",
    },
  };
}

async function prepareOne(
  library: PreparedLibrary,
  source: ReadingSource,
  attemptedAt: string,
  signal?: AbortSignal,
): Promise<{ feed: PreparedFeed; attempted: boolean; processed: number }> {
  let previous: PreparedSource | undefined;
  let attempted = false;
  try {
    if (signal?.aborted) throw cancel();
    const url = normalizeFeedUrl(source.url);
    const sourceId = sourceIdFor(url);
    previous = await library.prepared(sourceId, signal);
    if (signal?.aborted) throw cancel();

    const input: SourceInput = {
      url,
      ...(previous?.batch && previous.validators ? { validators: previous.validators } : {}),
    };
    attempted = true;
    let fetched: SourceFetchResult;
    try {
      fetched = await fetchFeedWithDeadline(input, signal);
    } catch (error) {
      if (isCancellation(error, signal)) throw cancel(error);
      const message = sourceError(error);
      try {
        const failed = await library.prepare({ sourceId, attemptedAt, issues: [message] }, signal);
        if (signal?.aborted) throw cancel();
        const recorded = failed.attemptedAt === attemptedAt;
        return {
          feed: {
            source,
            ...(failed.batch ? { batch: failed.batch } : {}),
            issues: recorded
              ? issuesAfterFailure(failed)
              : [
                  `An earlier feed retrieval failed at ${attemptedAt}: ${message}`,
                  ...(failed.batch
                    ? [`The current successful snapshot is from ${failed.batch.collectedAt}.`]
                    : []),
                ],
            attemptedAt: failed.attemptedAt,
          },
          attempted: true,
          processed: 0,
        };
      } catch (writeError) {
        if (isCancellation(writeError, signal)) throw cancel(writeError);
        return {
          feed: {
            source,
            ...(previous?.batch ? { batch: previous.batch } : {}),
            issues: [
              `Feed retrieval failed: ${message}`,
              `The refresh failure could not be recorded: ${sourceError(writeError)}`,
              ...previousSnapshotIssue(previous?.batch),
            ],
            attemptedAt,
          },
          attempted: true,
          processed: 0,
        };
      }
    }

    if (signal?.aborted) throw cancel();
    if (fetched.notModified) {
      if (!previous?.batch)
        throw new Error("The feed returned not modified without a saved snapshot.");
      const unchanged = await library.prepare(
        {
          sourceId,
          attemptedAt,
          issues: partialSnapshotIssues(previous),
          notModified: previous.batch.id,
          ...(fetched.validators ? { validators: fetched.validators } : {}),
        },
        signal,
      );
      if (signal?.aborted) throw cancel();
      return {
        feed: {
          source,
          ...(unchanged.batch ? { batch: unchanged.batch } : {}),
          issues: unchanged.issues,
          attemptedAt: unchanged.attemptedAt,
        },
        attempted: true,
        processed: 0,
      };
    }

    const { items, issues } = prepareFeedEntries(fetched, sourceId, url);
    if (signal?.aborted) throw cancel();
    const save = saveRequest(sourceId, attemptedAt, items, issues);
    const prepared = await library.prepare(
      {
        sourceId,
        attemptedAt,
        issues: entryIssueStrings(issues),
        ...(fetched.validators ? { validators: fetched.validators } : {}),
        save,
      },
      signal,
    );
    if (signal?.aborted) throw cancel();
    return {
      feed: {
        source,
        ...(prepared.batch ? { batch: prepared.batch } : {}),
        issues: prepared.issues,
        attemptedAt: prepared.attemptedAt,
      },
      attempted: true,
      processed: prepared.batch?.id === save.batch.id ? prepared.batch.items.length : 0,
    };
  } catch (error) {
    if (isCancellation(error, signal)) throw cancel(error);
    return {
      feed: {
        source,
        ...(previous?.batch ? { batch: previous.batch } : {}),
        issues: [
          `Feed preparation failed: ${sourceError(error)}`,
          ...previousSnapshotIssue(previous?.batch),
        ],
        attemptedAt,
      },
      attempted,
      processed: 0,
    };
  }
}

/** Revalidate enabled sources, persisting each refresh and reusing snapshots after failures. */
export async function prepareSources(
  library: PreparedLibrary,
  sources: ReadingSource[],
  signal?: AbortSignal,
  now = Date.now(),
): Promise<PreparationResult> {
  if (signal?.aborted) throw cancel();
  if (!Number.isFinite(now)) throw new Error("Invalid source preparation time.");

  const disambiguated = sources.map((source, index) =>
    sources.some((other, otherIndex) => otherIndex !== index && other.name === source.name)
      ? { ...source, name: `${index + 1}. ${source.name}` }
      : source,
  );
  const enabled = disambiguated.filter((source) => source.enabled);
  if (enabled.length === 0) {
    return { feeds: [], enabledSources: 0, refreshed: 0, processed: 0 };
  }

  const attemptedAt = new Date(now).toISOString();
  const feeds: PreparedFeed[] = [];
  let refreshed = 0;
  let processed = 0;

  for (let offset = 0; offset < enabled.length; offset += maxConcurrentFeeds) {
    const group = enabled.slice(offset, offset + maxConcurrentFeeds);
    const results = await Promise.all(
      group.map((source) => prepareOne(library, source, attemptedAt, signal)),
    );
    for (const result of results) {
      feeds.push(result.feed);
      if (result.attempted) refreshed++;
      processed += result.processed;
    }
  }

  if (signal?.aborted) throw cancel();
  return { feeds, enabledSources: enabled.length, refreshed, processed };
}
