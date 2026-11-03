import { dataRoot } from "../sources/paths.ts";
import { SQLiteContentLibrary } from "./store.ts";
import type { ContentLibrary } from "./types.js";

export const contentLibraryApiVersion = 2 as const;

export type ContentLibraryApi = ContentLibrary & { readonly apiVersion: 2 };
export type OpenContentLibraryOptions = { root?: string };

export function openContentLibrary(options: OpenContentLibraryOptions = {}): ContentLibraryApi {
  return Object.assign(new SQLiteContentLibrary(options.root ?? dataRoot()), {
    apiVersion: contentLibraryApiVersion,
  });
}

export type {
  ContentLibrary,
  LibraryCandidate,
  LibraryContent,
  LibraryBatch,
  LibraryItem,
  ReadRequest,
  SaveRequest,
  SearchRequest,
} from "./types.js";
export type { Batch, SourceBatch, SourceItem } from "../sources/types.js";
