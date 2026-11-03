import { dataRoot } from "../sources/paths.ts";
import { SQLiteContentLibrary } from "./store.ts";
import type { ContentLibrary } from "./types.js";

export const contentLibraryApiVersion = 1 as const;

export type ContentLibraryApiV1 = ContentLibrary & { readonly apiVersion: 1 };
export type OpenContentLibraryOptions = { root?: string };

export function openContentLibrary(options: OpenContentLibraryOptions = {}): ContentLibraryApiV1 {
  return Object.assign(new SQLiteContentLibrary(options.root ?? dataRoot()), {
    apiVersion: contentLibraryApiVersion,
  });
}

export type {
  ContentLibrary,
  LibraryBatch,
  LibraryItem,
  ReadRequest,
  SaveRequest,
  SearchRequest,
} from "./types.js";
export type { Batch, SourceBatch, SourceItem } from "../sources/types.js";
