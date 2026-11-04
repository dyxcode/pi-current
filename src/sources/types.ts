import type { LibraryCandidate } from "../library/types.ts";

export type FeedValidators = { url: string; etag?: string; lastModified?: string };

export type SourceItem = {
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  author?: string;
  summary?: string;
  text: string;
  retrievedAt: string;
  discoveredAt?: string;
  observedPosition?: number;
  sourceCompleteness: "unknown" | "known-partial";
  truncated: boolean;
  metadata?: Record<string, string | number | boolean | null>;
};
export type SourceBatch = {
  items: SourceItem[];
  failures: {
    externalId: string;
    code: string;
  }[];
  stopReason: string;
};

export type Batch = SourceBatch & {
  id: string;
  sourceId: string;
  collectedAt: string;
};

/** Feed parsing returns content; source preparation assigns its stable identity. */
export type SourceEntry = Omit<SourceItem, "sourceId"> | Omit<LibraryCandidate, "sourceId">;
export type SourceInput = { url: string; validators?: FeedValidators };
export type SourceIssue = { index: number; message: string };
export type SourceFetchResult = {
  items: SourceEntry[];
  issues: SourceIssue[];
  validators?: FeedValidators;
  notModified?: boolean;
};
