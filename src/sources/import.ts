import { createHash } from "node:crypto";
import type { LibraryContent } from "../library/types.ts";
import { answer } from "../library/validation.mjs";
import { ReadError } from "../web/read-types.ts";
import { fetchFeed as readFeed } from "./feed.ts";
import type { SourceEntry, SourceFetchResult, SourceInput, SourceIssue } from "./types.ts";

const fetchTimeoutMs = 30_000;
const maxMetadataCharacters = 4_096;
const maxUrlCharacters = 8_192;

/** Canonicalize a configured feed URL before deriving its stable source identity. */
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
