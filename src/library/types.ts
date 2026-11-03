import type { SourceItem, Batch } from "../sources/types.js";

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
export type SearchRequest = { query: string; source?: string; limit?: number };
export type ReadRequest = { itemId: string; versionId?: string; maxCharacters?: number };
/** Domain boundary for a future database extension; no SQL or Pi objects cross it. */
export interface ContentLibrary {
  save(request: SaveRequest, signal?: AbortSignal): Promise<LibraryBatch>;
  latest(sourceId?: string, signal?: AbortSignal): Promise<LibraryBatch | undefined>;
  search(request: SearchRequest, signal?: AbortSignal): Promise<LibraryItem[]>;
  read(request: ReadRequest, signal?: AbortSignal): Promise<LibraryItem | undefined>;
  remove(itemId: string, signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}
