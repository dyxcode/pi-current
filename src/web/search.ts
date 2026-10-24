/** Public search contracts, independent of Pi and the transport. */
export const MAX_QUERY_CHARACTERS = 2_000;
export const MAX_EVIDENCE_CHARACTERS = 20_000;
export const SEARCH_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 1_048_576;

export type SearchErrorCode =
  | "INVALID_INPUT"
  | "RATE_LIMITED"
  | "AUTH_REQUIRED"
  | "TIMEOUT"
  | "CANCELLED"
  | "NETWORK_ERROR"
  | "PROVIDER_ERROR"
  | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE";

export class SearchError extends Error {
  readonly code: SearchErrorCode;

  constructor(code: SearchErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "SearchError";
  }
}

export type SearchInput = { query: string; limit: number };
export type SearchResult = {
  provider: "exa";
  accessMode: "keyless";
  scope: "web";
  query: string;
  requestedLimit: number;
  retrievedAt: string;
  evidenceText: string;
  completeness: "search-excerpts";
  truncated: boolean;
};

export function validateSearchInput(input: unknown): SearchInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new SearchError("INVALID_INPUT", "Provide a query and an optional limit.");
  }
  const values = input as Record<string, unknown>;
  if (Object.keys(values).some((key) => key !== "query" && key !== "limit")) {
    throw new SearchError("INVALID_INPUT", "Only query and limit are supported.");
  }
  if (typeof values.query !== "string") {
    throw new SearchError("INVALID_INPUT", "Query must be a string.");
  }
  const query = values.query.trim();
  if (query.length === 0 || [...query].length > MAX_QUERY_CHARACTERS) {
    throw new SearchError("INVALID_INPUT", "Query must contain 1–2,000 characters after trimming.");
  }
  const limit = values.limit === undefined ? 5 : values.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new SearchError("INVALID_INPUT", "Limit must be an integer from 1 to 10.");
  }
  return { query, limit };
}

export function searchResult(input: SearchInput, evidenceText: string): SearchResult {
  const characters = [...evidenceText];
  return {
    provider: "exa",
    accessMode: "keyless",
    scope: "web",
    query: input.query,
    requestedLimit: input.limit,
    retrievedAt: new Date().toISOString(),
    evidenceText: characters.slice(0, MAX_EVIDENCE_CHARACTERS).join(""),
    completeness: "search-excerpts",
    truncated: characters.length > MAX_EVIDENCE_CHARACTERS,
  };
}
