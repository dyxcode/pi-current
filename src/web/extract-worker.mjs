import { parentPort, workerData } from "node:worker_threads";
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";

/** @typedef {import("./read-types.ts").ExtractedDocument} ExtractedDocument */
/** @type {{bytes: Uint8Array, url: string, contentType: string, maxElements: number}} */
const input = workerData;
/** @type {JSDOM | undefined} */
let dom;

class ExtractionError extends Error {
  /** @param {import("./read-types.ts").ReadErrorCode} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @param {string} text */
function cleanText(text) {
  // Remove terminal control sequences while preserving ordinary text formatting.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: These control characters are the sanitizer's explicit target.
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
/** @param {string | null | undefined} value @param {number} [max] */
function metadata(value, max = 1_000) {
  return value?.trim() ? [...cleanText(value.trim())].slice(0, max).join("") : undefined;
}

try {
  /** @type {ExtractedDocument} */
  let result;
  const mime = input.contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mime !== "text/html") {
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(input.contentType)?.[1] ?? "utf-8";
    let text;
    try {
      text = cleanText(new TextDecoder(charset, { fatal: true }).decode(input.bytes));
    } catch {
      throw new ExtractionError(
        "UNSUPPORTED_ENCODING",
        "Could not decode the page's declared text encoding.",
      );
    }
    if (!text.trim())
      throw new ExtractionError("NO_READABLE_CONTENT", "The page contains no readable text.");
    result = { contentKind: "plain-text", text, warnings: [] };
  } else {
    // No runScripts, resource loader, browser state or console forwarding.
    dom = new JSDOM(Buffer.from(input.bytes), {
      url: input.url,
      contentType: input.contentType,
      virtualConsole: new VirtualConsole(),
    });
    const document = dom.window.document;
    if (document.getElementsByTagName("*").length > input.maxElements) {
      throw new ExtractionError(
        "PARSE_ERROR",
        "The page exceeds the 30,000-element parsing limit.",
      );
    }
    const title = document.title.toLowerCase();
    const bodyText = document.body?.textContent ?? "";
    const loginForm = document.querySelector('input[type="password"]') !== null;
    const accessHint =
      /(?:sign in|log in|subscribe) to (?:read|continue|unlock)|登录后|登录以|订阅后/i.test(
        bodyText,
      );
    const challenge = /verify you are human|just a moment|security check|安全验证|人机验证/i.test(
      title,
    );
    /** @type {string[]} */
    const warnings = [];
    if (challenge || (bodyText.length < 1_000 && (loginForm || accessHint))) {
      throw new ExtractionError(
        "ACCESS_REQUIRED",
        "This appears to be a login, subscription or verification page. Browser access may be required.",
      );
    }
    if (loginForm || accessHint)
      warnings.push(
        "The page contains access-related prompts; the extracted article may be a preview.",
      );
    if (/enable javascript|please turn on javascript|请启用.*javascript/i.test(bodyText)) {
      warnings.push("The page requests JavaScript; dynamic content may be missing.");
    }
    const article = new Readability(document, {
      maxElemsToParse: input.maxElements,
      charThreshold: 200,
    }).parse();
    const text = cleanText(article?.textContent ?? "").trim();
    if (!article || text.length < 80) {
      throw new ExtractionError(
        "NO_READABLE_CONTENT",
        "No substantial article text was extracted. The page may need browser rendering.",
      );
    }
    const extractedTitle = metadata(article.title);
    const byline = metadata(article.byline);
    const publishedAt = metadata(article.publishedTime, 256);
    result = {
      contentKind: "extracted-article",
      text,
      warnings,
      ...(extractedTitle ? { title: extractedTitle } : {}),
      ...(byline ? { byline } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    };
  }
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  const safe =
    error instanceof ExtractionError
      ? error
      : new ExtractionError("PARSE_ERROR", "Could not extract readable content from the page.");
  parentPort?.postMessage({ ok: false, code: safe.code, message: safe.message });
} finally {
  dom?.window.close();
  parentPort?.close();
}
