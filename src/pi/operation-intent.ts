import { canonicalUrl } from "../sources/types.ts";

export type OperationIntent = {
  source: string;
  operation: string;
  query?: string;
  url?: string;
  limit: number;
  save: boolean;
};

/** Parse only direct, anchored user requests; source names resolve separately. */
export function operationIntent(text: string): OperationIntent | undefined {
  let source: string | undefined;
  let operation: string | undefined;
  let query: string | undefined;
  let url: string | undefined;
  let limit = 5;
  let save = false;
  const search = /^(?:please )?search\s+(.+?)\s+for\s+(.+?)\s+limit\s+(\d+)[.!]?$/i.exec(text);
  const fetchSearch =
    /^(?:please )?fetch( and save)?\s+(\d+)\s+items?\s+from\s+(.+?)\s+search:\s*(.+)$/i.exec(text);
  const feed =
    /^(?:please )?(show|fetch)( and save)?\s+(\d+)\s+(hot[- ]list items?|recommendations?|collections?)\s+from\s+(.+?)[.!]?$/i.exec(
      text,
    );
  const ownRead =
    /^(?:please )?read( and save)?\s+own\s+(https?:\/\/\S+)\s+from\s+(.+?)[.!]?$/i.exec(text);
  const savedRead = /^(?:please )?read and save\s+(https?:\/\/\S+)\s+from\s+(.+?)[.!]?$/i.exec(
    text,
  );
  const chineseSearch = /^(?:请)?搜索(.+?)[：:]\s*(.+?)[，,]\s*最多\s*(\d+)\s*条[。！!]?$/u.exec(
    text,
  );
  const chineseFeed =
    /^(?:请)?(读取并保存|查看|读取)(.+?)(热榜|首页推荐|收藏)\s*(\d+)\s*条(?:内容)?[。！!]?$/u.exec(
      text,
    );
  const explicit =
    /^(?:please )?run\s+([a-z][a-z0-9-]*)\s+from\s+(.+?)\s+limit\s+(\d+)(?:\s+(query|url):\s*(.+?))?(\s+and save)?$/i.exec(
      text,
    );
  if (search || chineseSearch) {
    const match = search ?? chineseSearch;
    if (!match) return;
    source = match[1];
    query = match[2];
    limit = Number(match[3]);
    operation = "search";
  } else if (fetchSearch) {
    save = Boolean(fetchSearch[1]);
    limit = Number(fetchSearch[2]);
    source = fetchSearch[3];
    query = fetchSearch[4];
    operation = "fetch-search";
  } else if (feed) {
    save = Boolean(feed[2]);
    limit = Number(feed[3]);
    source = feed[5];
    const entry = /^hot/i.test(feed[4]!)
      ? "hot-list"
      : /^recommend/i.test(feed[4]!)
        ? "recommendations"
        : "collections";
    operation = `${feed[1]!.toLowerCase() === "fetch" ? "fetch-" : ""}${entry}`;
    if (feed[1]!.toLowerCase() === "show" && save) return;
  } else if (chineseFeed) {
    save = chineseFeed[1] === "读取并保存";
    source = chineseFeed[2];
    limit = Number(chineseFeed[4]);
    const entry =
      chineseFeed[3] === "热榜"
        ? "hot-list"
        : chineseFeed[3] === "首页推荐"
          ? "recommendations"
          : "collections";
    operation = `${chineseFeed[1] === "查看" ? "" : "fetch-"}${entry}`;
  } else if (ownRead) {
    save = Boolean(ownRead[1]);
    url = ownRead[2];
    source = ownRead[3];
    operation = "own-read";
    limit = 1;
  } else if (savedRead) {
    save = true;
    url = savedRead[1];
    source = savedRead[2];
    operation = "read";
    limit = 1;
  } else if (explicit) {
    operation = explicit[1];
    source = explicit[2];
    limit = Number(explicit[3]);
    save = Boolean(explicit[6]);
    if (explicit[4]?.toLowerCase() === "query") query = explicit[5];
    if (explicit[4]?.toLowerCase() === "url") url = explicit[5];
  } else return;
  if (!source?.trim() || !operation || !Number.isInteger(limit) || limit < 1 || limit > 10) return;
  if (query !== undefined && (!query.trim() || query.length > 200)) return;
  try {
    if (url !== undefined) url = canonicalUrl(url);
  } catch {
    return;
  }
  return {
    source: source.trim(),
    operation: operation.toLowerCase(),
    limit,
    save,
    ...(query === undefined ? {} : { query: query.trim() }),
    ...(url === undefined ? {} : { url }),
  };
}
