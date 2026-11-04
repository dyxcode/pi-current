import type { ContentLibrary, LibraryItem } from "../library/types.ts";
import { prepareSources, type PreparationResult } from "../sources/prepare.ts";
import type { ReadingSource } from "./sources.ts";

export type DiscoveryInput = { terms?: string[]; limit?: number };
export type DiscoveryItem = { item: LibraryItem; sourceName: string; matchedTerms: string[] };
export type DiscoveryIssue = { source: string; message: string };
export type DiscoveryResult = {
  items: DiscoveryItem[];
  issues: DiscoveryIssue[];
  enabledSources: number;
};

type RankedCandidate = {
  content: LibraryItem;
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

function discoveryLimit(input: DiscoveryInput): number {
  const limit = input.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("Invalid reading input: limit must be an integer from 1 to 10.");
  }
  return limit;
}

function loadedFeeds(preparation: PreparationResult): LoadedFeed[] {
  return preparation.feeds.map((feed) => ({
    candidates: (feed.batch?.items ?? []).map((content, index) => ({
      content,
      sourceName: feed.source.name,
      order: index,
      titleMatches: 0,
      summaryMatches: 0,
      matchedTerms: [],
    })),
    issues: feed.issues.map((message) => ({ source: feed.source.name, message })),
  }));
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

function articleKey(content: LibraryItem): string {
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

/** Select from the persisted feed snapshot without saving or copying library items. */
export function selectPreparedReading(
  preparation: PreparationResult,
  input: DiscoveryInput = {},
): DiscoveryResult {
  const limit = discoveryLimit(input);

  const loaded = loadedFeeds(preparation);
  const terms = searchTerms(input.terms);
  const selected =
    terms.length > 0 ? selectForTerms(loaded, terms, limit) : selectMixed(loaded, limit);
  return {
    items: selected.map((candidate) => ({
      item: candidate.content,
      sourceName: candidate.sourceName,
      matchedTerms: candidate.matchedTerms,
    })),
    issues: loaded.flatMap(({ issues }) => issues),
    enabledSources: preparation.enabledSources,
  };
}

/** Refresh enabled feeds, then select current local items for existing callers. */
export async function discoverReading(
  library: Pick<ContentLibrary, "prepare" | "prepared">,
  sources: ReadingSource[],
  input: DiscoveryInput = {},
  signal?: AbortSignal,
): Promise<DiscoveryResult> {
  discoveryLimit(input);
  if (signal?.aborted) throw new Error("CANCELLED");
  const preparation = await prepareSources(library, sources, signal);
  return selectPreparedReading(preparation, input);
}
