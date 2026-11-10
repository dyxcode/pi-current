import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchFeedWithDeadline, normalizeFeedUrl } from "../sources/import.ts";
import { discoverFeed, type FeedCandidate } from "../sources/feed-discovery.ts";
import type { SourceFetchResult } from "../sources/types.ts";
import { safeRoot } from "../sources/paths.ts";

export type ReadingSource = { name: string; url: string; enabled: boolean };
export type AddSourceResult =
  | { source: ReadingSource; added: boolean; issues: string[] }
  | { candidates: FeedCandidate[]; added: false; issues: string[] };

const sourceFileName = "sources.json";
const sourceUpdates = new Map<string, Promise<void>>();
const defaultSources: ReadingSource[] = [
  { name: "MIT Research", url: "https://news.mit.edu/rss/research", enabled: true },
  { name: "JSTOR Daily", url: "https://daily.jstor.org/feed", enabled: true },
  { name: "Psyche", url: "https://psyche.co/feed.rss", enabled: true },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sourceList(value: unknown): ReadingSource[] {
  if (!Array.isArray(value)) throw new Error("Invalid source list: expected an array.");

  const urls = new Set<string>();
  return value.map((entry, index) => {
    const position = index + 1;
    if (!isRecord(entry)) {
      throw new Error(`Invalid source list: source ${position} must be an object.`);
    }
    if (
      typeof entry.name !== "string" ||
      !entry.name.trim() ||
      entry.name.trim().length > 100 ||
      /\p{Cc}/u.test(entry.name)
    ) {
      throw new Error(
        `Invalid source list: source ${position} needs a name of 1 to 100 characters without control characters.`,
      );
    }
    if (typeof entry.url !== "string") {
      throw new Error(`Invalid source list: source ${position} needs an HTTP(S) feed URL.`);
    }

    let url: string;
    try {
      url = normalizeFeedUrl(entry.url);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid URL";
      throw new Error(`Invalid source list: source ${position} has an invalid feed URL: ${detail}`);
    }
    if (urls.has(url)) {
      throw new Error(`Duplicate feed URL in source list: ${url}. This feed is already present.`);
    }
    urls.add(url);

    if (typeof entry.enabled !== "boolean") {
      throw new Error(`Invalid source list: source ${position} needs an enabled boolean.`);
    }
    return { name: entry.name.trim(), url, enabled: entry.enabled };
  });
}

function freshDefaults(): ReadingSource[] {
  return defaultSources.map((source) => ({ ...source }));
}

/** Read the locally configured discovery feeds, returning defaults only when no file exists. */
export async function readSources(root: string): Promise<ReadingSource[]> {
  const sourcePath = join(safeRoot(root), sourceFileName);
  let serialized: string;
  try {
    serialized = await readFile(sourcePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return freshDefaults();
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Invalid saved source list: the local file does not contain valid JSON.");
  }
  return sourceList(value);
}

/** Persist a validated, normalized local source list without acquiring any feed content. */
export async function writeSources(
  root: string,
  sources: ReadingSource[],
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("CANCELLED");
  const checked = sourceList(sources);
  const safeDirectory = safeRoot(root);
  await mkdir(safeDirectory, { recursive: true });

  const sourcePath = join(safeDirectory, sourceFileName);
  const temporaryPath = join(safeDirectory, `.${sourceFileName}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(checked, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    if (signal?.aborted) throw new Error("CANCELLED");
    await rename(temporaryPath, sourcePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** Serialize local read-modify-write updates for one runtime data directory. */
export async function updateSources(
  root: string,
  update: (sources: ReadingSource[]) => ReadingSource[],
  signal?: AbortSignal,
): Promise<void> {
  const safeDirectory = safeRoot(root);
  const previous = sourceUpdates.get(safeDirectory) ?? Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(async () => {
      if (signal?.aborted) throw new Error("CANCELLED");
      const current = await readSources(safeDirectory);
      if (signal?.aborted) throw new Error("CANCELLED");
      const updated = update(current);
      if (signal?.aborted) throw new Error("CANCELLED");
      if (updated !== current) await writeSources(safeDirectory, updated, signal);
    });
  sourceUpdates.set(safeDirectory, pending);

  try {
    await pending;
  } finally {
    if (sourceUpdates.get(safeDirectory) === pending) sourceUpdates.delete(safeDirectory);
  }
}

/** Resolve a website or feed URL and validate the selected feed before saving it. */
export async function addSource(
  root: string,
  input: { name: string; url: string },
  signal?: AbortSignal,
): Promise<AddSourceResult> {
  if (signal?.aborted) throw new Error("CANCELLED");
  const candidate = sourceList([{ name: input.name, url: input.url, enabled: true }])[0];
  if (!candidate) throw new Error("Invalid source list: expected a source.");

  const existing = await readSources(root);
  if (signal?.aborted) throw new Error("CANCELLED");
  const duplicate = existing.find((source) => source.url === candidate.url);
  if (duplicate) return { source: duplicate, added: false, issues: [] };

  const discovery = await discoverFeed(candidate.url, signal);
  if (signal?.aborted) throw new Error("CANCELLED");
  let resolved = candidate;
  let fetched: SourceFetchResult;
  if ("candidates" in discovery) {
    const selected = discovery.candidates[0];
    if (discovery.candidates.length !== 1 || !selected) {
      return { candidates: discovery.candidates, added: false, issues: [] };
    }
    resolved = { ...candidate, url: selected.url };
    const configured = (await readSources(root)).find((source) => source.url === selected.url);
    if (signal?.aborted) throw new Error("CANCELLED");
    if (configured) return { source: configured, added: false, issues: [] };
    fetched = await fetchFeedWithDeadline({ url: resolved.url }, signal);
  } else {
    fetched = discovery.feed;
  }
  if (signal?.aborted) throw new Error("CANCELLED");
  const issues = [...new Set(fetched.issues.map(({ message }) => message))];
  let result = { source: resolved, added: true, issues };

  await updateSources(
    root,
    (sources) => {
      const concurrent = sources.find((source) => source.url === resolved.url);
      if (concurrent) {
        result = { source: concurrent, added: false, issues };
        return sources;
      }
      return [...sources, resolved];
    },
    signal,
  );

  return result;
}
