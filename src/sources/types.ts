import { MAX_ARTICLE_BYTES, MAX_SUMMARY_CHARACTERS } from "./content-limits.mjs";

export type AuthState =
  | "not-connected"
  | "not-required"
  | "unknown"
  | "ready"
  | "login-required"
  | "expired"
  | "verification-required";
export type Capabilities = {
  login: boolean;
  check: boolean;
  read: boolean;
  collect: boolean;
};
export type SourceItem = {
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  author?: string;
  summary?: string;
  text: string;
  retrievedAt: string;
  discoveredAt?: string;
  observedPosition?: number;
  sourceCompleteness: "unknown" | "known-partial";
  truncated: boolean;
  metadata?: Record<string, string | number | boolean | null>;
};
export type SourceBatch = {
  items: SourceItem[];
  failures: {
    externalId: string;
    code: string;
  }[];
  stopReason: string;
};
export type SourceConnection = {
  id: string;
  name: string;
  login: boolean;
  check: boolean;
};
export type SourceOperationSpec = {
  id: string;
  name: string;
  kind: "discover" | "read" | "acquire";
  connection: string;
  connections?: string[];
  input?: "query" | "url";
};
export type SourceOperationRequest = {
  limit: number;
  maxRequests: number;
  // Presentation preference; article bodies are retained under separate byte ceilings.
  maxCharacters: number;
  query?: string;
  url?: string;
};
export type SourceDiscovery = {
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  summary: string;
  contentType: string;
  discoveredAt: string;
  observedPosition?: number;
};
export type SourceDiscoveryBatch = {
  items: SourceDiscovery[];
  stopReason: string;
};
export type SourceOperationResult =
  | { kind: "discovery"; batch: SourceDiscoveryBatch; failureConnection?: string }
  | { kind: "content"; batch: SourceBatch; failureConnection?: string };
export type Batch = SourceBatch & {
  id: string;
  sourceId: string;
  collectedAt: string;
};
export type SourceContext = {
  sourceId: string;
  dataDir: string;
};
export interface SourceAdapter {
  login?(signal: AbortSignal): Promise<void>;
  check?(signal: AbortSignal): Promise<AuthState>;
  read?(url: string, maxCharacters: number, signal: AbortSignal): Promise<SourceItem>;
  collect?(limit: number, signal: AbortSignal): Promise<SourceBatch>;
  perform?(
    operation: string,
    request: SourceOperationRequest,
    signal: AbortSignal,
  ): Promise<SourceOperationResult>;
  loginConnection?(connection: string, signal: AbortSignal): Promise<void>;
  checkConnection?(connection: string, signal: AbortSignal): Promise<AuthState>;
  close(): Promise<void>;
}
/** Trusted local code. Import/create must not initiate login, checks or collection. */
export interface SourcePlugin {
  apiVersion: 1;
  id: string;
  name: string;
  hosts: string[];
  capabilities: Capabilities;
  connections?: SourceConnection[];
  operations?: SourceOperationSpec[];
  create(context: SourceContext): Promise<SourceAdapter>;
}
export type ConnectionState = {
  auth: AuthState;
  checkedAt?: string;
  problem?: string;
  pause?: string;
};
export type SourceState = {
  auth: AuthState;
  checkedAt?: string;
  problem?: string;
  pause?: string;
  connections?: Record<string, ConnectionState>;
};
export type Registration = {
  id: string;
  name: string;
  modulePath: string;
  hosts: string[];
  capabilities: Capabilities;
  connections?: SourceConnection[];
  operations?: SourceOperationSpec[];
  enabled: boolean;
};
export type SourceStatus = Omit<Registration, "connections"> &
  Omit<SourceState, "connections"> & {
    connections?: SourceConnection[];
    connectionStates?: Record<string, ConnectionState>;
  };
export const ERROR_CODES = [
  "SOURCE_ERROR",
  "SOURCE_BUSY",
  "SOURCE_DISABLED",
  "SOURCE_NOT_FOUND",
  "SOURCE_ALREADY_REGISTERED",
  "SOURCE_URL_MISMATCH",
  "SOURCE_AMBIGUOUS",
  "SOURCE_CAPABILITY_UNAVAILABLE",
  "SOURCE_INVALID_RESULT",
  "SOURCE_INVALID_INPUT",
  "PLUGIN_INVALID",
  "PLUGIN_LOAD_FAILED",
  "PLUGIN_CHANGED",
  "PLUGIN_CLOSE_FAILED",
  "REGISTRY_INVALID",
  "STATE_IO_ERROR",
  "LOGIN_REQUIRED",
  "ACCESS_DENIED",
  "RATE_LIMITED",
  "VERIFICATION_REQUIRED",
  "NETWORK_ERROR",
  "HTTP_ERROR",
  "TIMEOUT",
  "CANCELLED",
  "BROWSER_MISSING",
  "BROWSER_BUSY",
  "BROWSER_ERROR",
  "PAGE_CHANGED",
  "NO_READABLE_CONTENT",
  "RESPONSE_TOO_LARGE",
  "RESPONSE_INVALID",
] as const;
export const PAUSES = ["ACCESS_DENIED", "RATE_LIMITED", "VERIFICATION_REQUIRED"] as const;
export function safeCode(error: unknown): string {
  return error instanceof Error && ERROR_CODES.some((code) => error.message === code)
    ? error.message
    : "SOURCE_ERROR";
}
export function validId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value))
    throw new Error("PLUGIN_INVALID");
}
export function canonicalUrl(value: string): string {
  try {
    const u = new URL(value);
    if (
      !["https:", "http:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      value.length > 8192
    )
      throw new Error();
    u.hash = "";
    return u.href;
  } catch {
    throw new Error("SOURCE_INVALID_INPUT");
  }
}
export function validateItem(
  value: unknown,
  sourceId: string,
  maxCharacters: number = MAX_ARTICLE_BYTES,
): asserts value is SourceItem {
  if (!value || typeof value !== "object") throw new Error("SOURCE_INVALID_RESULT");
  const v = value as Record<string, unknown>;
  if (
    v.sourceId !== sourceId ||
    typeof v.externalId !== "string" ||
    !v.externalId ||
    v.externalId.length > 256 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: External item IDs must not contain control characters.
    /[\u0000-\u001f]/.test(v.externalId) ||
    typeof v.url !== "string" ||
    typeof v.title !== "string" ||
    v.title.length > 2000 ||
    typeof v.text !== "string" ||
    !v.text.trim() ||
    Buffer.byteLength(v.text, "utf8") > MAX_ARTICLE_BYTES ||
    (maxCharacters < MAX_ARTICLE_BYTES && [...v.text].length > maxCharacters) ||
    (v.summary !== undefined &&
      (typeof v.summary !== "string" || [...v.summary].length > MAX_SUMMARY_CHARACTERS)) ||
    (v.author !== undefined && (typeof v.author !== "string" || v.author.length > 1000)) ||
    typeof v.retrievedAt !== "string" ||
    !Number.isFinite(Date.parse(v.retrievedAt)) ||
    !["unknown", "known-partial"].includes(String(v.sourceCompleteness)) ||
    typeof v.truncated !== "boolean"
  )
    throw new Error("SOURCE_INVALID_RESULT");
  try {
    canonicalUrl(v.url);
  } catch {
    throw new Error("SOURCE_INVALID_RESULT");
  }
  if (
    v.discoveredAt !== undefined &&
    (typeof v.discoveredAt !== "string" || !Number.isFinite(Date.parse(v.discoveredAt)))
  )
    throw new Error("SOURCE_INVALID_RESULT");
  if (
    v.observedPosition !== undefined &&
    (!Number.isInteger(v.observedPosition) || Number(v.observedPosition) < 1)
  )
    throw new Error("SOURCE_INVALID_RESULT");
  if (
    Object.keys(v).some(
      (k) =>
        ![
          "sourceId",
          "externalId",
          "url",
          "title",
          "author",
          "summary",
          "text",
          "retrievedAt",
          "discoveredAt",
          "observedPosition",
          "sourceCompleteness",
          "truncated",
          "metadata",
        ].includes(k),
    )
  )
    throw new Error("SOURCE_INVALID_RESULT");
  if (v.metadata !== undefined) {
    if (
      !v.metadata ||
      typeof v.metadata !== "object" ||
      Array.isArray(v.metadata) ||
      JSON.stringify(v.metadata).length > 4096
    )
      throw new Error("SOURCE_INVALID_RESULT");
    for (const [key, field] of Object.entries(v.metadata))
      if (
        !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) ||
        /cookie|token|secret|password|authorization/i.test(key) ||
        (field !== null && !["string", "number", "boolean"].includes(typeof field)) ||
        (typeof field === "number" && !Number.isFinite(field))
      )
        throw new Error("SOURCE_INVALID_RESULT");
  }
}
