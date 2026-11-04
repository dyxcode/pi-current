import type { ContentLibrary, LibraryContent, LibraryItem } from "../library/types.ts";
import {
  fetchFeedWithDeadline,
  normalizeFeedUrl,
  prepareFeedEntries,
  saveFeedBatch,
  sourceIdFor,
} from "../sources/import.ts";
import type { SourceInput, SourceIssue } from "../sources/types.ts";
import type { ReadingSource } from "./sources.ts";

const maxCandidatesPerFeed = 20;

type DiscoveryInput = { terms?: string[]; limit?: number };
type DiscoveryItem = { item: LibraryItem; sourceName: string; matchedTerms: string[] };
type DiscoveryIssue = { source: string; message: string };
type DiscoveryResult = {
  items: DiscoveryItem[];
  issues: DiscoveryIssue[];
  enabledSources: number;
};

type RankedCandidate = {
  content: LibraryContent;
  sourceName: string;
  order: number;
  titleMatches: number;
  summaryMatches: number;
  matchedTerms: string[];
};

type LoadedFeed = {
  candidates: RankedCandidate[];
  issues: DiscoveryIssue[];
};

type SearchTerm = { original: string; normalized: string };

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function searchTerms(values: string[] | undefined): SearchTerm[] {
  const distinct = new Map<string, SearchTerm>();
  for (const original of values ?? []) {
    const normalized = normalizedText(original.trim());
    if (normalized && !distinct.has(normalized)) distinct.set(normalized, { original, normalized });
  }
  return [...distinct.values()];
}

function sourceError(error: unknown): string {
  return error instanceof Error ? error.message : "Feed retrieval failed.";
}

function discoveryIssues(source: string, issues: SourceIssue[]): DiscoveryIssue[] {
  return issues.map(({ index, message }) => ({
    source,
    message: `Entry ${index + 1}: ${message}`,
  }));
}

async function loadFeed(source: ReadingSource, signal?: AbortSignal): Promise<LoadedFeed> {
  try {
    const url = normalizeFeedUrl(source.url);
    const sourceId = sourceIdFor(url);
    const input: SourceInput = { url, limit: maxCandidatesPerFeed };
    const fetched = await fetchFeedWithDeadline(input, signal);
    if (signal?.aborted) throw new Error("CANCELLED");
    const prepared = prepareFeedEntries(fetched, sourceId, url);
    const issues = discoveryIssues(source.name, prepared.issues);
    const candidates: RankedCandidate[] = prepared.items.map((content, index) => ({
      content,
      sourceName: source.name,
      order: index,
      titleMatches: 0,
      summaryMatches: 0,
      matchedTerms: [],
    }));
    return { candidates, issues };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.message === "CANCELLED")) {
      throw new Error("CANCELLED", { cause: error });
    }
    return {
      candidates: [],
      issues: [{ source: source.name, message: sourceError(error) }],
    };
  }
}

function matchesFor(candidate: RankedCandidate, terms: SearchTerm[]): RankedCandidate {
  const title = normalizedText(candidate.content.title);
  const summary = normalizedText(candidate.content.summary ?? "");
  const titleTerms = terms.filter(({ normalized }) => title.includes(normalized));
  const summaryTerms = terms.filter(({ normalized }) => summary.includes(normalized));
  const matched = new Set([...titleTerms, ...summaryTerms].map(({ normalized }) => normalized));
  return {
    ...candidate,
    titleMatches: titleTerms.length,
    summaryMatches: summaryTerms.length,
    matchedTerms: terms
      .filter(({ normalized }) => matched.has(normalized))
      .map(({ original }) => original),
  };
}

function publishedTime(candidate: RankedCandidate): number | undefined {
  const value = candidate.content.metadata?.publishedAt;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function comparePublishedAt(left: RankedCandidate, right: RankedCandidate): number {
  const leftTime = publishedTime(left);
  const rightTime = publishedTime(right);
  if (leftTime === undefined) return rightTime === undefined ? 0 : 1;
  if (rightTime === undefined) return -1;
  return rightTime - leftTime;
}

function articleKey(content: LibraryContent): string {
  const url = new URL(content.url);
  url.hash = "";
  return url.href;
}

function selectForTerms(
  feeds: LoadedFeed[],
  terms: SearchTerm[],
  limit: number,
): RankedCandidate[] {
  let order = 0;
  const candidates = feeds.flatMap((feed) =>
    feed.candidates.map((candidate) => ({
      ...matchesFor(candidate, terms),
      order: order++,
    })),
  );
  candidates.sort(
    (left, right) =>
      right.titleMatches - left.titleMatches ||
      right.summaryMatches - left.summaryMatches ||
      comparePublishedAt(left, right) ||
      left.order - right.order,
  );

  const selected: RankedCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.titleMatches + candidate.summaryMatches === 0) continue;
    const key = articleKey(candidate.content);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected;
}

function selectMixed(feeds: LoadedFeed[], limit: number): RankedCandidate[] {
  const queues = feeds.map((feed) =>
    [...feed.candidates].sort(
      (left, right) => comparePublishedAt(left, right) || left.order - right.order,
    ),
  );
  const selected: RankedCandidate[] = [];
  const seen = new Set<string>();

  while (selected.length < limit) {
    let found = false;
    for (const queue of queues) {
      while (queue.length > 0) {
        const candidate = queue.shift();
        if (!candidate) break;
        const key = articleKey(candidate.content);
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(candidate);
        found = true;
        break;
      }
      if (selected.length >= limit) break;
    }
    if (!found) break;
  }
  return selected;
}

function acknowledgedKey(sourceId: string, externalId: string): string {
  return `${sourceId}\0${externalId}`;
}

/** Fetch, rank, deduplicate, and save a bounded local reading selection. */
export async function discoverReading(
  library: Pick<ContentLibrary, "save">,
  sources: ReadingSource[],
  input: DiscoveryInput,
  signal?: AbortSignal,
): Promise<DiscoveryResult> {
  const limit = input.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("Invalid reading input: limit must be an integer from 1 to 10.");
  }
  if (signal?.aborted) throw new Error("CANCELLED");

  const enabled = sources
    .map((source, index) =>
      sources.some((other, otherIndex) => otherIndex !== index && other.name === source.name)
        ? { ...source, name: `${index + 1}. ${source.name}` }
        : source,
    )
    .filter((source) => source.enabled);
  if (enabled.length === 0) return { items: [], issues: [], enabledSources: 0 };
  const terms = searchTerms(input.terms);
  const startedAt = new Date().toISOString();

  const loaded: LoadedFeed[] = [];
  for (let offset = 0; offset < enabled.length; offset += 3) {
    const group = enabled.slice(offset, offset + 3);
    loaded.push(...(await Promise.all(group.map((source) => loadFeed(source, signal)))));
  }
  if (signal?.aborted) throw new Error("CANCELLED");

  const selected =
    terms.length > 0 ? selectForTerms(loaded, terms, limit) : selectMixed(loaded, limit);
  const issues = loaded.flatMap(({ issues: feedIssues }) => feedIssues);
  if (selected.length === 0) return { items: [], issues, enabledSources: enabled.length };

  const groups = new Map<
    string,
    { sourceName: string; sourceId: string; items: LibraryContent[] }
  >();
  for (const candidate of selected) {
    const sourceId = candidate.content.sourceId;
    let group = groups.get(sourceId);
    if (!group) {
      group = {
        sourceName: candidate.sourceName,
        sourceId,
        items: [],
      };
      groups.set(sourceId, group);
    }
    group.items.push(candidate.content);
  }

  const acknowledged = new Map<string, LibraryItem>();
  for (const group of groups.values()) {
    if (signal?.aborted) throw new Error("CANCELLED");
    try {
      const saved = await saveFeedBatch(
        library,
        {
          sourceId: group.sourceId,
          requestedCount: limit,
          startedAt,
          items: group.items,
          issues: [],
          stopReason: selected.length >= limit ? "limit" : "complete",
        },
        signal,
      );
      for (const item of saved.items) {
        acknowledged.set(acknowledgedKey(item.sourceId, item.externalId), item);
      }
    } catch (error) {
      if (signal?.aborted) throw new Error("CANCELLED", { cause: error });
      const sourceName = group.sourceName;
      issues.push({ source: sourceName, message: `Save failed: ${sourceError(error)}` });
    }
  }
  if (signal?.aborted) throw new Error("CANCELLED");

  const items: DiscoveryItem[] = [];
  for (const candidate of selected) {
    const saved = acknowledged.get(
      acknowledgedKey(candidate.content.sourceId, candidate.content.externalId),
    );
    if (saved) {
      items.push({
        item: saved,
        sourceName: candidate.sourceName,
        matchedTerms: candidate.matchedTerms,
      });
    }
  }
  return { items, issues, enabledSources: enabled.length };
}
