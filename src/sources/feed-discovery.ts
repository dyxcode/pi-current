import { JSDOM, VirtualConsole } from "jsdom";
import { type DownloadedPage, fetchPublicPage } from "../web/http-page.ts";
import { abortFailure, MAX_DOM_ELEMENTS, READ_TIMEOUT_MS, ReadError } from "../web/read-types.ts";
import { parseDownloadedFeed } from "./feed.ts";
import { normalizeFeedUrl } from "./import.ts";
import type { SourceFetchResult } from "./types.ts";

const FEED_MEDIA_TYPES = new Set(["application/rss+xml", "application/atom+xml"]);
const HTML_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml"]);

export type FeedCandidate = { url: string; title?: string };

function mediaType(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function decodePage(page: DownloadedPage): string {
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(page.contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset, { fatal: true }).decode(page.bytes);
  } catch {
    throw new ReadError(
      "UNSUPPORTED_ENCODING",
      "The website's declared text encoding is unsupported.",
    );
  }
}

function usableUrl(value: string, base: string): string | undefined {
  if (!value.trim()) return undefined;
  try {
    return normalizeFeedUrl(new URL(value.trim(), base).href);
  } catch {
    return undefined;
  }
}

function pageBase(document: Document, finalUrl: string): string {
  for (const element of Array.from(document.querySelectorAll("base[href]"))) {
    const value = element.getAttribute("href");
    if (!value) continue;
    const resolved = usableUrl(value, finalUrl);
    if (resolved) return resolved;
  }
  return finalUrl;
}

function discoverHtmlCandidates(page: DownloadedPage): FeedCandidate[] {
  const dom = new JSDOM(decodePage(page), {
    contentType: "text/html",
    url: page.finalUrl,
    virtualConsole: new VirtualConsole(),
  });
  try {
    const document = dom.window.document;
    if (document.getElementsByTagName("*").length > MAX_DOM_ELEMENTS) {
      throw new ReadError("PARSE_ERROR", "The website exceeds the 30,000-element parsing limit.");
    }

    const base = pageBase(document, page.finalUrl);
    const seen = new Set<string>();
    const candidates: FeedCandidate[] = [];
    for (const element of Array.from(document.querySelectorAll("link[rel][type][href]"))) {
      const rel = (element.getAttribute("rel") ?? "").toLowerCase().split(/[\t\n\f\r ]+/);
      if (!rel.includes("alternate")) continue;
      const type = (element.getAttribute("type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
      if (!type || !FEED_MEDIA_TYPES.has(type)) continue;
      const href = element.getAttribute("href");
      if (!href) continue;
      const url = usableUrl(href, base);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = element.getAttribute("title")?.trim();
      candidates.push({ url, ...(title ? { title } : {}) });
    }
    return candidates;
  } finally {
    dom.window.close();
  }
}

/** Fetch one public page and either parse it as a feed or list its declared feed links. */
export async function discoverFeed(
  input: string,
  signal?: AbortSignal,
): Promise<{ url: string; feed: SourceFetchResult } | { candidates: FeedCandidate[] }> {
  const lifetime = new AbortController();
  const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  if (combined.aborted) throw abortFailure(combined);
  const timer = setTimeout(
    () =>
      lifetime.abort(
        new ReadError("TIMEOUT", `Feed retrieval exceeded its ${READ_TIMEOUT_MS} ms deadline.`),
      ),
    READ_TIMEOUT_MS,
  );

  try {
    const url = normalizeFeedUrl(input);
    const page = await fetchPublicPage(url, combined, "feed");
    if (combined.aborted) throw abortFailure(combined);

    try {
      const feed = parseDownloadedFeed(page);
      if (combined.aborted) throw abortFailure(combined);
      return { url, feed };
    } catch (cause) {
      if (page.partial || page.notModified || !HTML_MEDIA_TYPES.has(mediaType(page.contentType))) {
        throw cause;
      }
      if (combined.aborted) throw abortFailure(combined);
      return { candidates: discoverHtmlCandidates(page) };
    }
  } catch (cause) {
    if (combined.aborted) throw abortFailure(combined);
    throw cause;
  } finally {
    clearTimeout(timer);
    lifetime.abort();
  }
}
