import { createHash, randomUUID } from "node:crypto";
import { answer } from "../library/validation.mjs";
import type { ContentLibrary, LibraryBatch, LibraryContent } from "../library/types.ts";
import type { SourceIssue, SourceModule } from "./types.ts";

const fetchTimeoutMs = 30_000;
const maxMetadataCharacters = 4_096;
const maxUrlCharacters = 8_192;
const moduleIdPattern = /^[a-z][a-z0-9-]{0,63}$/;

export type ImportInput = { url: string; limit: number };
export type ImportResult = { sourceId: string; batch: LibraryBatch; issues: SourceIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeInput(value: unknown): ImportInput {
  if (!isRecord(value)) {
    throw new Error("Invalid source input: expected an object with url and limit.");
  }
  if (
    typeof value.limit !== "number" ||
    !Number.isInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 10
  ) {
    throw new Error("Invalid source input: limit must be an integer from 1 to 10.");
  }
  if (typeof value.url !== "string" || value.url.length > 8192) {
    throw new Error("Invalid source input: url must be an HTTP or HTTPS URL.");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("Invalid source input: url must be an HTTP or HTTPS URL.");
  }
  if (!(["http:", "https:"].includes(url.protocol) && !url.username && !url.password)) {
    throw new Error("Invalid source input: url must be an HTTP or HTTPS URL without credentials.");
  }
  url.hash = "";
  if (url.href.length > maxUrlCharacters) {
    throw new Error("Invalid source input: normalized url exceeds 8,192 characters.");
  }
  return { url: url.href, limit: value.limit };
}

function sourceIdFor(module: SourceModule, url: string): string {
  const digest = createHash("sha256").update(`${module.id}\0${url}`).digest("hex").slice(0, 40);
  return `feed-${digest}`;
}

function validateModule(module: SourceModule): void {
  if (
    !module ||
    typeof module !== "object" ||
    !moduleIdPattern.test(module.id) ||
    typeof module.name !== "string" ||
    !module.name.trim() ||
    module.name.length > 80 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Source names must not contain control characters.
    /[\u0000-\u001f\u007f]/.test(module.name) ||
    typeof module.fetch !== "function"
  ) {
    throw new Error("Invalid source module: expected a valid id, name, and fetch function.");
  }
}

function fetchWithDeadline(
  module: SourceModule,
  input: ImportInput,
  caller?: AbortSignal,
): Promise<unknown> {
  if (caller?.aborted) return Promise.reject(new Error("CANCELLED"));
  const timeoutController = new AbortController();
  const combined = AbortSignal.any([timeoutController.signal, ...(caller ? [caller] : [])]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  timeout = setTimeout(() => timeoutController.abort(new Error("SOURCE_TIMEOUT")), fetchTimeoutMs);
  const fetching = Promise.resolve().then(() => {
    if (combined.aborted) {
      throw caller?.aborted ? new Error("CANCELLED") : new Error("SOURCE_TIMEOUT");
    }
    return module.fetch(input, { signal: combined });
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () =>
      reject(caller?.aborted ? new Error("CANCELLED") : new Error("SOURCE_TIMEOUT"));
    if (combined.aborted) onAbort();
    else combined.addEventListener("abort", onAbort, { once: true });
    fetching.finally(() => combined.removeEventListener("abort", onAbort)).catch(() => {});
  });
  return Promise.race([fetching, aborted]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

function issue(index: number, message: string): SourceIssue {
  return { index, message: message || "Source reported an unspecified issue." };
}

function validatedIssues(value: unknown): SourceIssue[] {
  if (!Array.isArray(value))
    throw new Error("Source returned invalid issue details: issues must be an array.");
  const issues: SourceIssue[] = [];
  value.forEach((entry, position) => {
    if (
      isRecord(entry) &&
      Number.isInteger(entry.index) &&
      Number(entry.index) >= 0 &&
      Number(entry.index) <= 1_000_000 &&
      typeof entry.message === "string" &&
      entry.message.length > 0
    ) {
      issues.push(issue(Number(entry.index), entry.message));
    } else {
      throw new Error(`Source returned invalid issue details at index ${position}.`);
    }
  });
  return issues;
}

function safeEntry(
  value: unknown,
  sourceId: string,
  moduleId: string,
  sourceUrl: string,
  index: number,
): LibraryContent {
  if (!isRecord(value)) throw new Error("Invalid source entry.");
  const metadata = value.metadata === undefined ? {} : value.metadata;
  if (!isRecord(metadata)) throw new Error("Invalid source metadata.");
  const mergedMetadata: Record<string, unknown> = {
    ...metadata,
    sourceUrl,
    sourceModule: moduleId,
  };
  if (
    mergedMetadata.feedUrl === sourceUrl &&
    JSON.stringify(mergedMetadata).length > maxMetadataCharacters
  ) {
    // sourceUrl already preserves this exact value, so drop the redundant field only to fit the library schema.
    delete mergedMetadata.feedUrl;
  }
  const entry = {
    ...value,
    sourceId,
    metadata: mergedMetadata,
    ...(value.observedPosition === undefined ? { observedPosition: index + 1 } : {}),
  };
  answer(entry);
  return entry;
}

function fetchResult(value: unknown): { items: unknown[]; issues: SourceIssue[] } {
  if (!isRecord(value) || !Array.isArray(value.items) || !Array.isArray(value.issues)) {
    throw new Error("Source returned an invalid fetch result: expected items and issues arrays.");
  }
  return { items: value.items, issues: validatedIssues(value.issues) };
}

/** Fetch one source input and save its valid, source-scoped entries through the library API. */
export async function importSource(
  module: SourceModule,
  library: Pick<ContentLibrary, "save">,
  inputValue: ImportInput,
  signal?: AbortSignal,
): Promise<ImportResult> {
  validateModule(module);
  const input = normalizeInput(inputValue);
  if (signal?.aborted) throw new Error("CANCELLED");

  const sourceId = sourceIdFor(module, input.url);
  const provenanceLength = JSON.stringify({ sourceUrl: input.url, sourceModule: module.id }).length;
  if (provenanceLength > maxMetadataCharacters) {
    throw new Error(
      "Invalid source input: provenance metadata exceeds the 4,096-character library limit.",
    );
  }
  const startedAt = new Date().toISOString();
  const issues: SourceIssue[] = [];
  let fetched: unknown;
  try {
    fetched = await fetchWithDeadline(module, input, signal);
  } catch (error) {
    if (signal?.aborted) throw new Error("CANCELLED", { cause: error });
    throw error;
  }
  if (signal?.aborted) throw new Error("CANCELLED");

  const result = fetchResult(fetched);
  issues.push(...result.issues);
  const items: LibraryContent[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < result.items.length; index++) {
    if (index >= input.limit) {
      issues.push(
        issue(
          index,
          "Source returned more items than the requested limit; extra entries were skipped.",
        ),
      );
      break;
    }
    const raw = result.items[index];
    let entry: LibraryContent;
    try {
      entry = safeEntry(raw, sourceId, module.id, input.url, index);
    } catch {
      issues.push(issue(index, "Invalid source entry was skipped."));
      continue;
    }
    if (seen.has(entry.externalId)) {
      issues.push(issue(index, "Duplicate external ID was skipped."));
      continue;
    }
    seen.add(entry.externalId);
    items.push(entry);
  }
  issues.sort((left, right) => left.index - right.index);
  if (signal?.aborted) throw new Error("CANCELLED");

  const firstIssue = issues[0];
  const batch = {
    id: randomUUID(),
    sourceId,
    collectedAt: new Date().toISOString(),
    items,
    failures: firstIssue ? [{ externalId: String(firstIssue.index), code: "SOURCE_ISSUE" }] : [],
    stopReason: items.length >= input.limit ? "limit" : issues.length > 0 ? "partial" : "complete",
  };
  const saved = await library.save(
    {
      requestedCount: input.limit,
      startedAt,
      batch,
    },
    signal,
  );
  if (signal?.aborted) throw new Error("CANCELLED");
  return { sourceId, batch: saved, issues };
}
