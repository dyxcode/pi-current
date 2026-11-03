import { createHash } from "node:crypto";
import { JSDOM, VirtualConsole } from "jsdom";
import { MAX_ARTICLE_BYTES, MAX_SUMMARY_CHARACTERS } from "./content-limits.mjs";
import type { SourceEntry, SourceInput, SourceIssue, SourceFetchResult } from "./types.ts";
import { fetchPublicPage } from "../web/http-page.ts";
import { MAX_DOM_ELEMENTS, ReadError, type ReadErrorCode } from "../web/read-types.ts";

const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";
const RSS_CONTENT_NAMESPACE = "http://purl.org/rss/1.0/modules/content/";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const RSS_ROOTS = new Set(["rss", "RDF"]);
const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "blockquote",
  "div",
  "dl",
  "dt",
  "dd",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);
const OMITTED_ELEMENTS = new Set(["script", "style", "template", "noscript"]);

function error(code: ReadErrorCode, message: string): ReadError {
  return new ReadError(code, message);
}

function elements(parent: Element, name: string, namespace?: string): Element[] {
  return Array.from(parent.children).filter(
    (child) =>
      child.localName === name && (namespace === undefined || child.namespaceURI === namespace),
  );
}

function firstElement(parent: Element, name: string, namespace?: string): Element | undefined {
  return elements(parent, name, namespace)[0];
}

function fieldText(element: Element | undefined): string | undefined {
  const value = element?.textContent?.trim();
  return value ? value : undefined;
}

function xmlBase(element: Element): string | undefined {
  return (
    element.getAttributeNS(XML_NAMESPACE, "base") ?? element.getAttribute("xml:base") ?? undefined
  );
}

function baseFor(element: Element, feedUrl: string): string | undefined {
  const path: Element[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    path.push(current);
  }
  let base = feedUrl;
  for (const current of path.reverse()) {
    const value = xmlBase(current);
    if (!value) continue;
    try {
      base = new URL(value, base).href;
    } catch {
      return undefined;
    }
  }
  return base;
}

function usableUrl(input: string | undefined, base: string | undefined): string | undefined {
  if (!input?.trim() || [...input].length > 8_192) return undefined;
  let url: URL;
  try {
    url = new URL(input.trim(), base);
    url.hash = "";
  } catch {
    return undefined;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname ||
    [...url.href].length > 8_192
  ) {
    return undefined;
  }
  return url.href;
}

function rssArticleUrl(entry: Element, feedUrl: string): string | undefined {
  const link = firstElement(entry, "link");
  const linkUrl = link ? usableUrl(fieldText(link), baseFor(link, feedUrl)) : undefined;
  if (linkUrl) return linkUrl;
  const guid = firstElement(entry, "guid");
  const permalink = guid?.getAttribute("isPermaLink")?.trim().toLowerCase();
  if (!guid || (permalink && permalink !== "true")) return undefined;
  return usableUrl(fieldText(guid), undefined);
}

function atomArticleUrl(entry: Element, feedUrl: string): string | undefined {
  const alternatives = elements(entry, "link", ATOM_NAMESPACE).filter((link) => {
    const rel = link.getAttribute("rel")?.trim().toLowerCase();
    return !rel || rel === "alternate";
  });
  alternatives.sort((left, right) => {
    const score = (element: Element) =>
      ["text/html", "application/xhtml+xml"].includes(
        element.getAttribute("type")?.trim().toLowerCase() ?? "",
      )
        ? 0
        : 1;
    return score(left) - score(right);
  });
  for (const link of alternatives) {
    const articleUrl = usableUrl(link.getAttribute("href") ?? undefined, baseFor(link, feedUrl));
    if (articleUrl) return articleUrl;
  }
  return undefined;
}

function plainHtml(html: string, parser: DOMParser): string {
  const document = parser.parseFromString(html, "text/html");
  if (document.getElementsByTagName("*").length > MAX_DOM_ELEMENTS) {
    throw error("PARSE_ERROR", "Inline HTML exceeds the 30,000-element parsing limit.");
  }
  for (const element of document.querySelectorAll("script, style, template, noscript")) {
    element.remove();
  }
  let output = "";
  const newline = () => {
    if (output && !output.endsWith("\n")) output += "\n";
  };
  const visit = (node: Node): void => {
    if (node.nodeType === node.TEXT_NODE) {
      output += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== node.ELEMENT_NODE) {
      for (const child of Array.from(node.childNodes)) visit(child);
      return;
    }
    const element = node as Element;
    const tag = element.localName.toLowerCase();
    if (OMITTED_ELEMENTS.has(tag)) return;
    if (tag === "br" || tag === "hr") {
      newline();
      return;
    }
    const block = BLOCK_ELEMENTS.has(tag);
    if (block) newline();
    if (tag === "li") output += "- ";
    for (const child of Array.from(element.childNodes)) visit(child);
    if (block) newline();
  };
  for (const child of Array.from(document.body.childNodes)) visit(child);
  return output
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function xmlMarkup(element: Element): string {
  return Array.from(element.childNodes).some((node) => node.nodeType === node.ELEMENT_NODE)
    ? element.innerHTML
    : (element.textContent ?? "");
}

type AtomText = { text?: string; unsupported?: boolean };

function atomText(element: Element | undefined, parser: DOMParser): AtomText {
  if (!element || element.hasAttribute("src")) return {};
  const type = element.getAttribute("type")?.trim().toLowerCase() ?? "text";
  const value = type === "xhtml" ? element.innerHTML : xmlMarkup(element);
  if (
    type === "html" ||
    type === "text/html" ||
    type === "xhtml" ||
    type === "application/xhtml+xml"
  ) {
    const text = plainHtml(value, parser);
    return text ? { text } : {};
  }
  if (type === "text" || type === "text/plain") {
    const text = value.trim();
    return text ? { text } : {};
  }
  return { unsupported: true };
}

function rssText(element: Element | undefined, parser: DOMParser): string | undefined {
  if (!element) return undefined;
  const text = plainHtml(xmlMarkup(element), parser);
  return text || undefined;
}

function boundedId(value: string | undefined, url: string): string {
  const id = value?.trim() || url;
  if ([...id].length <= 256) return id;
  return `sha256:${createHash("sha256").update(id).digest("hex")}`;
}

function validDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function rssPublishedAt(entry: Element): string | undefined {
  return validDate(
    fieldText(firstElement(entry, "pubDate")) ?? fieldText(firstElement(entry, "date")),
  );
}

function atomPublishedAt(entry: Element): string | undefined {
  return (
    validDate(fieldText(firstElement(entry, "published", ATOM_NAMESPACE))) ??
    validDate(fieldText(firstElement(entry, "updated", ATOM_NAMESPACE)))
  );
}

function rssAuthor(entry: Element): string | undefined {
  return fieldText(firstElement(entry, "author")) ?? fieldText(firstElement(entry, "creator"));
}

function atomAuthor(entry: Element): string | undefined {
  const parent = entry.parentElement;
  const author =
    firstElement(entry, "author", ATOM_NAMESPACE) ??
    (parent?.localName === "feed" && parent.namespaceURI === ATOM_NAMESPACE
      ? firstElement(parent, "author", ATOM_NAMESPACE)
      : undefined);
  return fieldText(author && firstElement(author, "name", ATOM_NAMESPACE));
}

function withinTextLimit(value: string | undefined, max: number, bytes = false): boolean {
  if (value === undefined) return true;
  return bytes
    ? value.length <= max && Buffer.byteLength(value, "utf8") <= max
    : [...value].length <= max;
}

type EntryFields = {
  url?: string;
  externalId?: string;
  title?: string;
  author?: string;
  summary?: string;
  text?: string;
  publishedAt?: string;
};

function sourceEntry(
  fields: EntryFields,
  discoveredAt: string,
  observedPosition: number,
  feedUrl: string,
): SourceEntry | undefined {
  if (!fields.url) return undefined;
  const common = {
    externalId: boundedId(fields.externalId, fields.url),
    url: fields.url,
    title: fields.title ?? "",
    observedPosition,
    ...(fields.author ? { author: fields.author } : {}),
    ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
    metadata: {
      feedUrl,
      ...(fields.publishedAt ? { publishedAt: fields.publishedAt } : {}),
    },
  };
  if (fields.text) {
    return {
      ...common,
      text: fields.text,
      retrievedAt: discoveredAt,
      discoveredAt,
      sourceCompleteness: "unknown",
      truncated: false,
    };
  }
  return { ...common, discoveredAt };
}

function parseEntry(
  element: Element,
  isAtom: boolean,
  feedUrl: string,
  parser: DOMParser,
  discoveredAt: string,
  observedPosition: number,
): { entry?: SourceEntry; message?: string } {
  const url = isAtom ? atomArticleUrl(element, feedUrl) : rssArticleUrl(element, feedUrl);
  if (!url) return { message: "The entry has no usable HTTP(S) article URL." };
  const namespace = isAtom ? ATOM_NAMESPACE : undefined;
  const id = fieldText(firstElement(element, isAtom ? "id" : "guid", namespace));
  const titleElement = firstElement(element, "title", namespace);
  const title = (isAtom ? atomText(titleElement, parser).text : fieldText(titleElement)) ?? "";
  const author = isAtom ? atomAuthor(element) : rssAuthor(element);
  const atomSummary = isAtom
    ? atomText(firstElement(element, "summary", namespace), parser)
    : undefined;
  const atomContent = isAtom
    ? atomText(firstElement(element, "content", namespace), parser)
    : undefined;
  const summary = isAtom
    ? atomSummary?.text
    : rssText(firstElement(element, "description"), parser);
  const content = isAtom
    ? atomContent?.text
    : rssText(
        elements(element, "encoded").find(
          (candidate) => candidate.namespaceURI === RSS_CONTENT_NAMESPACE,
        ),
        parser,
      );
  const publishedAt = isAtom ? atomPublishedAt(element) : rssPublishedAt(element);

  if (!withinTextLimit(title, 2_000)) {
    return { message: "The entry title exceeds the 2,000-character library limit." };
  }
  if (!withinTextLimit(author, 1_000)) {
    return { message: "The entry author exceeds the 1,000-character library limit." };
  }
  if (!withinTextLimit(summary, MAX_SUMMARY_CHARACTERS)) {
    return { message: "The entry summary exceeds the 5,000-character library limit." };
  }
  if (!withinTextLimit(content, MAX_ARTICLE_BYTES, true)) {
    return {
      message: "The inline body exceeds the 1 MiB library limit and was skipped without clipping.",
    };
  }

  if (observedPosition > 10_000) {
    return { message: "The entry's original position exceeds the 10,000-position library limit." };
  }
  const entry = sourceEntry(
    {
      url,
      ...(id ? { externalId: id } : {}),
      title,
      ...(author ? { author } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(content !== undefined ? { text: content } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    },
    discoveredAt,
    observedPosition,
    feedUrl,
  );
  return entry
    ? {
        entry,
        ...(atomSummary?.unsupported || atomContent?.unsupported
          ? { message: "The Atom content type is unsupported and was not stored as text." }
          : {}),
      }
    : { message: "The entry has no usable HTTP(S) article URL." };
}

function feedEntries(document: Document): { isAtom: boolean; entries: Element[] } {
  const root = document.documentElement;
  if (root.localName === "feed" && root.namespaceURI === ATOM_NAMESPACE) {
    return { isAtom: true, entries: elements(root, "entry", ATOM_NAMESPACE) };
  }
  if (RSS_ROOTS.has(root.localName)) {
    const channel = firstElement(root, "channel");
    if (root.localName === "rss" && !channel) {
      throw error("PARSE_ERROR", "The RSS document is missing its channel element.");
    }
    const parent = root.localName === "RDF" ? root : channel;
    return { isAtom: false, entries: parent ? elements(parent, "item") : [] };
  }
  throw error(
    "UNSUPPORTED_CONTENT",
    "The response is not an RSS or Atom feed; it may be an HTML error page.",
  );
}

export async function fetchFeed(
  input: SourceInput,
  signal: AbortSignal,
): Promise<SourceFetchResult> {
  if (signal.aborted) {
    throw error("CANCELLED", "Feed retrieval was cancelled.");
  }

  const page = await fetchPublicPage(input.url, signal, "feed");
  if (page.partial) {
    throw error(
      "UNSUPPORTED_CONTENT",
      "The feed response was partial; a complete XML document is required.",
    );
  }

  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(page.contentType)?.[1] ?? "utf-8";
  let xml: string;
  try {
    xml = new TextDecoder(charset, { fatal: true }).decode(page.bytes);
  } catch {
    throw error("UNSUPPORTED_ENCODING", "The feed's declared text encoding could not be decoded.");
  }
  if (!xml.trim()) throw error("PARSE_ERROR", "The feed response is empty.");

  let dom: JSDOM | undefined;
  const mime = page.contentType.split(";", 1)[0]?.trim().toLowerCase();
  try {
    dom = new JSDOM(xml, {
      contentType: "application/xml",
      url: page.finalUrl,
      virtualConsole: new VirtualConsole(),
    });
    const document = dom.window.document;
    if (document.getElementsByTagName("*").length > MAX_DOM_ELEMENTS) {
      throw error("PARSE_ERROR", "The feed exceeds the 30,000-element parsing limit.");
    }
    if (document.documentElement.localName === "parsererror") {
      throw error("PARSE_ERROR", "The feed XML is malformed or incomplete.");
    }
    const { isAtom, entries } = feedEntries(document);
    const parser = new dom.window.DOMParser();
    const items: SourceEntry[] = [];
    const issues: SourceIssue[] = [];
    const externalIds = new Set<string>();
    const discoveredAt = new Date().toISOString();

    for (const [index, entryElement] of entries.entries()) {
      if (items.length >= input.limit) break;
      let parsed: ReturnType<typeof parseEntry>;
      try {
        parsed = parseEntry(entryElement, isAtom, page.finalUrl, parser, discoveredAt, index + 1);
      } catch (cause) {
        issues.push({
          index,
          message:
            cause instanceof ReadError
              ? cause.message
              : "The inline entry content could not be parsed safely.",
        });
        continue;
      }
      if (parsed.message && parsed.entry) issues.push({ index, message: parsed.message });
      if (!parsed.entry) {
        issues.push({ index, message: parsed.message ?? "The feed entry could not be parsed." });
        continue;
      }
      if (externalIds.has(parsed.entry.externalId)) {
        issues.push({ index, message: "The feed entry duplicates an earlier ID or article URL." });
        continue;
      }
      externalIds.add(parsed.entry.externalId);
      items.push(parsed.entry);
    }
    return { items, issues };
  } catch (cause) {
    if (cause instanceof ReadError) throw cause;
    if (mime === "text/html") {
      throw error(
        "UNSUPPORTED_CONTENT",
        "The response is HTML rather than RSS or Atom and may be an error page.",
      );
    }
    throw error("PARSE_ERROR", "The feed XML is malformed, incomplete, or could not be parsed.");
  } finally {
    dom?.window.close();
  }
}
