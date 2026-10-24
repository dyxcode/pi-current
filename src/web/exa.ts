import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "./mcp-transport.ts";
import { CallToolResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_RESPONSE_BYTES,
  SEARCH_TIMEOUT_MS,
  SearchError,
  searchResult,
  validateSearchInput,
  type SearchResult,
} from "./search.ts";

const ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_exa";

function classifyError(error: unknown): SearchError {
  if (error instanceof SearchError) return error;
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) {
      return new SearchError("TIMEOUT", "Search exceeded 30 seconds. Try again later.");
    }
    return new SearchError(
      "PROVIDER_ERROR",
      "Exa rejected the MCP request. No fallback was attempted.",
    );
  }
  // Never expose upstream error bodies: they can echo queries or arbitrary text.
  return new SearchError(
    "INVALID_RESPONSE",
    "Exa returned an unsupported or malformed MCP response.",
  );
}

function httpError(response: Response): SearchError {
  if (response.status === 429) {
    const retry = response.headers.get("retry-after");
    const seconds = retry && /^\d{1,5}$/.test(retry) ? Number(retry) : undefined;
    const hint = seconds === undefined ? "Try again later." : `Retry after ${seconds} seconds.`;
    return new SearchError(
      "RATE_LIMITED",
      `Exa keyless search is rate limited. ${hint} No paid fallback was attempted.`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new SearchError(
      "AUTH_REQUIRED",
      "Exa keyless access is unavailable. No credentials were used.",
    );
  }
  return new SearchError(
    "PROVIDER_ERROR",
    `Exa returned HTTP ${response.status}. No fallback was attempted.`,
  );
}

/** One bounded, unauthenticated search. The caller owns intent and persistence. */
export async function searchWeb(input: unknown, signal?: AbortSignal): Promise<SearchResult> {
  const request = validateSearchInput(input);
  const lifetime = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  const abortError = () =>
    lifetime.signal.reason instanceof SearchError
      ? lifetime.signal.reason
      : new SearchError("CANCELLED", "Search was cancelled.");
  if (combinedSignal.aborted) throw abortError();

  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let finished = false;
  let rejectFailure: (error: SearchError) => void = () => {};
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const fail = (error: unknown) => {
    if (!finished) rejectFailure(combinedSignal.aborted ? abortError() : classifyError(error));
  };
  const onAbort = () => fail(abortError());
  combinedSignal.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    lifetime.abort(new SearchError("TIMEOUT", "Search exceeded 30 seconds. Try again later."));
  }, SEARCH_TIMEOUT_MS);

  // Bound streams before the SDK parses JSON or SSE, including responses without
  // Content-Length. Retain streaming so an SSE response need not close to finish.
  const boundedFetch: typeof fetch = async (url, init) => {
    if (String(url) !== ENDPOINT) {
      throw new SearchError(
        "NETWORK_ERROR",
        "The search transport attempted an unexpected endpoint.",
      );
    }
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("x-api-key");
    const fetchSignal = init?.signal
      ? AbortSignal.any([combinedSignal, init.signal])
      : combinedSignal;
    if (fetchSignal.aborted) throw abortError();
    let response: Response;
    try {
      response = await globalThis.fetch(url, {
        ...init,
        headers,
        credentials: "omit",
        redirect: "error",
        signal: fetchSignal,
      });
    } catch {
      throw combinedSignal.aborted
        ? abortError()
        : new SearchError(
            "NETWORK_ERROR",
            "Could not reach Exa. Check the connection and try again.",
          );
    }
    // MCP permits servers to decline the optional notification stream.
    if (init?.method === "GET" && response.status === 405) {
      await response.body?.cancel();
      return new Response(null, { status: 405 });
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw httpError(response);
    }
    const length = Number(response.headers.get("content-length"));
    if (length > MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => {});
      throw new SearchError(
        "RESPONSE_TOO_LARGE",
        "Exa response exceeded the 1 MiB limit. Try fewer results.",
      );
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    readers.add(reader);
    let bytes = 0;
    let ended = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          // The SDK cancels bodies it does not need (for example HTTP 202).
          // That cancellation may resolve an already-pending read.
          if (ended) return;
          if (chunk.done) {
            ended = true;
            readers.delete(reader);
            controller.close();
            return;
          }
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            throw new SearchError(
              "RESPONSE_TOO_LARGE",
              "Exa response exceeded the 1 MiB limit. Try fewer results.",
            );
          }
          controller.enqueue(chunk.value);
        } catch (error) {
          if (ended) return;
          ended = true;
          readers.delete(reader);
          void reader.cancel().catch(() => {});
          const safeError =
            error instanceof SearchError
              ? error
              : new SearchError("NETWORK_ERROR", "The Exa response stream was interrupted.");
          controller.error(safeError);
          fail(safeError);
        }
      },
      async cancel() {
        ended = true;
        readers.delete(reader);
        await reader.cancel();
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };

  const client = new Client({ name: "pi-current", version: "0.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: boundedFetch,
    requestInit: { credentials: "omit", redirect: "error" },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  client.onerror = fail;
  try {
    const operation = async () => {
      const options = { signal: combinedSignal, timeout: SEARCH_TIMEOUT_MS };
      await client.connect(transport, options);
      const response = CallToolResultSchema.parse(
        await client.callTool(
          {
            name: "web_search_exa",
            arguments: { query: request.query, numResults: request.limit },
          },
          undefined,
          options,
        ),
      );
      if (response.isError) {
        throw new SearchError(
          "PROVIDER_ERROR",
          "Exa could not complete the search. No fallback was attempted.",
        );
      }
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n\n");
      if (!text.trim()) {
        throw new SearchError("INVALID_RESPONSE", "Exa returned no usable search evidence.");
      }
      return searchResult(request, text);
    };
    return await Promise.race([operation(), failure]);
  } catch (error) {
    throw combinedSignal.aborted ? abortError() : classifyError(error);
  } finally {
    finished = true;
    clearTimeout(timeout);
    combinedSignal.removeEventListener("abort", onAbort);
    lifetime.abort();
    for (const reader of readers) void reader.cancel().catch(() => {});
    readers.clear();
    await client.close();
  }
}
