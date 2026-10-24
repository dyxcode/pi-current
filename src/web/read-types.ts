export const READ_TIMEOUT_MS = 30_000;
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_DOM_ELEMENTS = 30_000;
export const READ_ERROR_CODES = [
  "INVALID_INPUT",
  "BLOCKED_URL",
  "REDIRECT_ERROR",
  "ACCESS_DENIED",
  "ACCESS_REQUIRED",
  "RATE_LIMITED",
  "HTTP_ERROR",
  "UNSUPPORTED_CONTENT",
  "UNSUPPORTED_ENCODING",
  "NO_READABLE_CONTENT",
  "RESPONSE_TOO_LARGE",
  "PARSE_ERROR",
  "NETWORK_ERROR",
  "CANCELLED",
  "TIMEOUT",
] as const;
export type ReadErrorCode = (typeof READ_ERROR_CODES)[number];
export class ReadError extends Error {
  readonly code: ReadErrorCode;
  constructor(code: ReadErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReadError";
    this.code = code;
  }
}
export type ReadInput = { url: string; maxCharacters: number };
export type ExtractedDocument = {
  contentKind: "extracted-article" | "plain-text";
  text: string;
  title?: string;
  byline?: string;
  publishedAt?: string;
  warnings: string[];
};
export type ReadResult = ExtractedDocument & {
  requestedUrl: string;
  finalUrl: string;
  retrievedAt: string;
  retrievalMethod: "direct-http";
  contentType: string;
  sourceCompleteness: "unknown" | "known-partial";
  truncated: boolean;
};

export function validateReadInput(value: unknown): ReadInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReadError("INVALID_INPUT", "Provide a public URL and optional maxCharacters.");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "url" && key !== "maxCharacters")) {
    throw new ReadError("INVALID_INPUT", "Only url and maxCharacters are supported.");
  }
  if (typeof input.url !== "string" || !input.url.trim() || [...input.url.trim()].length > 8_192) {
    throw new ReadError("INVALID_INPUT", "URL must contain 1–8,192 characters.");
  }
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new ReadError("INVALID_INPUT", "Provide an absolute HTTP or HTTPS URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new ReadError(
      "INVALID_INPUT",
      "Only HTTP(S) URLs without embedded credentials are supported.",
    );
  }
  url.hash = "";
  if (url.href.length > 8_192) {
    throw new ReadError("INVALID_INPUT", "The normalized URL exceeds 8,192 characters.");
  }
  const maxCharacters = input.maxCharacters === undefined ? 20_000 : input.maxCharacters;
  if (
    typeof maxCharacters !== "number" ||
    !Number.isInteger(maxCharacters) ||
    maxCharacters < 1_000 ||
    maxCharacters > 50_000
  ) {
    throw new ReadError("INVALID_INPUT", "maxCharacters must be an integer from 1,000 to 50,000.");
  }
  return { url: url.href, maxCharacters };
}

export function abortFailure(signal: AbortSignal): ReadError {
  return signal.reason instanceof ReadError
    ? signal.reason
    : new ReadError("CANCELLED", "Page reading was cancelled.");
}

/** DNS promises are not abortable; prevent a late result from starting a socket. */
export async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortFailure(signal);
  let listener: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    listener = () => reject(abortFailure(signal));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([pending, stopped]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
