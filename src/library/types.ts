import type { Batch, FeedValidators, SourceItem } from "../sources/types.js";

/** A discovery observation without acquired article text or body provenance. */
export type LibraryCandidate = Omit<
  SourceItem,
  "text" | "retrievedAt" | "sourceCompleteness" | "truncated" | "discoveredAt"
> & {
  discoveredAt: string;
  text?: never;
  retrievedAt?: never;
  sourceCompleteness?: never;
  truncated?: never;
};
export type LibraryContent = SourceItem | LibraryCandidate;
export type LibraryItem = LibraryContent & {
  itemId: string;
  versionId: string;
  displayTruncated?: boolean;
};
export type LibraryBatch = Omit<Batch, "items"> & { items: LibraryItem[] };
export type SaveRequest = {
  batch: Omit<Batch, "items"> & { items: LibraryContent[] };
  requestedCount: number;
  startedAt: string;
};
export type PreparationRequest = {
  sourceId: string;
  attemptedAt: string;
  issues: string[];
  validators?: FeedValidators;
  /** ID of the saved batch whose representation received a conditional 304 response. */
  notModified?: string;
  save?: SaveRequest;
};
export type PreparedSource = {
  sourceId: string;
  attemptedAt: string;
  issues: string[];
  validators?: FeedValidators;
  batch?: LibraryBatch;
};
export type SearchRequest = { query: string; source?: string; limit?: number };
export type ReadRequest = { itemId: string; versionId?: string; maxCharacters?: number };
/** Domain boundary for a future database extension; no SQL or Pi objects cross it. */
export interface ContentLibrary {
  save(request: SaveRequest, signal?: AbortSignal): Promise<LibraryBatch>;
  prepare(request: PreparationRequest, signal?: AbortSignal): Promise<PreparedSource>;
  prepared(sourceId: string, signal?: AbortSignal): Promise<PreparedSource | undefined>;
  latest(sourceId?: string, signal?: AbortSignal): Promise<LibraryBatch | undefined>;
  search(request: SearchRequest, signal?: AbortSignal): Promise<LibraryItem[]>;
  read(request: ReadRequest, signal?: AbortSignal): Promise<LibraryItem | undefined>;
  remove(itemId: string, signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}
