import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  createSearchHarness,
  defaultToolResult,
  installMockExaServer,
  jsonRpcResponse,
  MCP_ENDPOINT,
  syntheticEvidenceText,
} from "./helpers/search-harness.mjs";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function callRequests(calls) {
  return calls.filter((call) => call.rpc?.method === "tools/call");
}

function codeIs(code) {
  return (error) => {
    assert.ok(error instanceof Error, "tool failures must be readable Errors");
    assert.ok(error.message.includes(code), `error message must include ${code}: ${error.message}`);
    return true;
  };
}

function textOutput(result) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function runSearch(harness, params, signal) {
  return harness.tool.execute("test-search-call", params, signal, undefined);
}

function restoreEnvironment(t, key) {
  const previous = process.env[key];
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

test("current_web_search uses keyless Exa MCP and returns a provenance envelope", async (t) => {
  restoreEnvironment(t, "EXA_API_KEY");
  process.env.EXA_API_KEY = "synthetic-secret-must-not-be-used";
  const harness = await createSearchHarness(t);
  const server = installMockExaServer(t);

  const result = await runSearch(harness, { query: "  explain current web search  " });
  const contentText = textOutput(result);
  const structured = result.structuredContent;

  assert.equal(harness.tool.name, "current_web_search");
  assert.equal(
    callRequests(server.calls).length,
    1,
    "one user call must make one provider tool call",
  );
  assert.equal(
    server.calls.every((call) => call.url === MCP_ENDPOINT),
    true,
  );
  const call = callRequests(server.calls)[0];
  assert.equal(call.rpc.params.name, "web_search_exa");
  assert.deepEqual(call.rpc.params.arguments, {
    query: "explain current web search",
    numResults: 5,
  });
  for (const outbound of server.calls) {
    assert.equal(outbound.headers.has("authorization"), false);
    assert.equal(outbound.headers.has("cookie"), false);
    assert.equal(outbound.headers.has("x-api-key"), false);
    assert.equal(outbound.body?.includes("synthetic-secret-must-not-be-used") ?? false, false);
  }

  assert.equal(structured.provider, "exa");
  assert.equal(structured.accessMode, "keyless");
  assert.equal(structured.scope, "web");
  assert.equal(structured.query, "explain current web search");
  assert.equal(structured.requestedLimit, 5);
  assert.equal(structured.evidenceText, syntheticEvidenceText());
  assert.equal(structured.completeness, "search-excerpts");
  assert.equal(structured.truncated, false);
  assert.ok(Number.isFinite(Date.parse(structured.retrievedAt)), "retrievedAt must be a timestamp");
  assert.match(contentText, /Synthetic notice must be preserved/);
  assert.match(contentText, /https:\/\/example\.com\/synthetic-result/);
  assert.equal(
    server.calls.some((call) => call.url.startsWith("https://example.com/")),
    false,
  );
});

test("query and limit are validated after trimming, with Unicode code-point boundaries", async (t) => {
  const harness = await createSearchHarness(t);
  const server = installMockExaServer(t);
  const invalid = [
    { query: " \n\t " },
    { query: "x".repeat(2001) },
    { query: "😀".repeat(2001) },
    { query: "valid", limit: 0 },
    { query: "valid", limit: 11 },
    { query: "valid", limit: 1.5 },
    { query: "valid", limit: "5" },
  ];

  for (const params of invalid) {
    await assert.rejects(runSearch(harness, params), codeIs("INVALID_INPUT"));
  }
  assert.equal(server.calls.length, 0, "invalid input must be rejected before any network request");

  const maxQuery = "😀".repeat(2000);
  const result = await runSearch(harness, { query: maxQuery, limit: 10 });
  const call = callRequests(server.calls)[0];
  assert.equal(call.rpc.params.arguments.query, maxQuery);
  assert.equal(call.rpc.params.arguments.numResults, 10);
  assert.equal(result.structuredContent.query, maxQuery);
  assert.equal(result.structuredContent.requestedLimit, 10);
});

test("Pi prepares the trimmed query before applying the schema length limit", async (t) => {
  const harness = await createSearchHarness(t);
  const server = installMockExaServer(t);
  const normalizedQuery = "x".repeat(2000);
  const toolCall = {
    type: "toolCall",
    id: "host-validation",
    name: harness.tool.name,
    arguments: { query: `  ${normalizedQuery}  ` },
  };
  const preparedCall = harness.tool.prepareArguments
    ? { ...toolCall, arguments: harness.tool.prepareArguments(toolCall.arguments) }
    : toolCall;
  let params;
  try {
    params = validateToolArguments(harness.tool, preparedCall);
  } catch {
    assert.fail("Pi host validation must accept a query whose trimmed length is 2,000 code points");
  }

  assert.equal(params.query, normalizedQuery);
  const result = await runSearch(harness, params);
  assert.equal(callRequests(server.calls)[0].rpc.params.arguments.query, normalizedQuery);
  assert.equal(result.structuredContent.query, normalizedQuery);
});

test("accepts a Streamable HTTP server response delivered as SSE", async (t) => {
  const harness = await createSearchHarness(t);
  const evidence = "SSE excerpt with a synthetic notice preserved.";
  const server = installMockExaServer(t, {
    onCall: () => ({ eventStream: true, result: defaultToolResult(evidence) }),
  });

  const result = await runSearch(harness, { query: "SSE response", limit: 1 });
  assert.equal(callRequests(server.calls).length, 1);
  assert.equal(result.structuredContent.evidenceText, evidence);
  assert.match(textOutput(result), /synthetic notice preserved/);
});

test("tolerates a non-null empty body on the MCP initialized HTTP 202", async (t) => {
  const harness = await createSearchHarness(t);
  const server = installMockExaServer(t, { initializedBody: "" });

  const result = await runSearch(harness, { query: "empty notification body" });
  assert.equal(result.structuredContent.query, "empty notification body");
  assert.equal(callRequests(server.calls).length, 1);
  assert.equal(
    server.calls.find((call) => call.rpc?.method === "notifications/initialized").method,
    "POST",
  );
});

test("an explicit no-results provider message is a successful search result", async (t) => {
  const harness = await createSearchHarness(t);
  const message = "No search results found. Please try a different query.";
  const server = installMockExaServer(t, { onCall: () => defaultToolResult(message) });

  const result = await runSearch(harness, { query: "no matching evidence" });
  assert.equal(callRequests(server.calls).length, 1);
  assert.equal(result.structuredContent.evidenceText, message);
  assert.equal(result.structuredContent.completeness, "search-excerpts");
  assert.equal(result.structuredContent.truncated, false);
  assert.match(textOutput(result), /No search results found/);
  assert.match(textOutput(result), /no matching evidence/);
});

test("maps provider and MCP failures to stable sanitized error codes", async (t) => {
  const cases = [
    {
      name: "HTTP 429",
      code: "RATE_LIMITED",
      response: () => new Response("secret upstream rate limit details", { status: 429 }),
    },
    {
      name: "HTTP 401",
      code: "AUTH_REQUIRED",
      response: () => new Response("secret account and credential details", { status: 401 }),
    },
    {
      name: "HTTP 503",
      code: "PROVIDER_ERROR",
      response: () => new Response("secret upstream stack trace", { status: 503 }),
    },
    {
      name: "MCP tool isError",
      code: "PROVIDER_ERROR",
      response: () => ({
        result: { isError: true, content: [{ type: "text", text: "secret tool error body" }] },
      }),
    },
    {
      name: "MCP JSON-RPC protocol error",
      code: "PROVIDER_ERROR",
      response: (rpc) =>
        jsonRpcResponse({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32000, message: "secret protocol response details" },
        }),
    },
    {
      name: "malformed MCP JSON",
      code: "INVALID_RESPONSE",
      response: () =>
        new Response("{not-json", { headers: { "content-type": "application/json" } }),
    },
    {
      name: "malformed MCP tool result",
      code: "INVALID_RESPONSE",
      response: () => ({
        result: { content: [{ type: "unknown-content-kind", text: "secret malformed" }] },
      }),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (st) => {
      const harness = await createSearchHarness(st);
      const secret = "secret";
      const server = installMockExaServer(st, {
        onCall: (rpc) => scenario.response(rpc),
      });
      await assert.rejects(runSearch(harness, { query: "mapped error" }), (error) => {
        codeIs(scenario.code)(error);
        assert.equal(error.message.includes(secret), false, "raw upstream details must not escape");
        return true;
      });
      assert.equal(
        callRequests(server.calls).length,
        1,
        "provider errors must not trigger retries",
      );
      assert.equal(
        server.calls.every((call) => call.url === MCP_ENDPOINT),
        true,
      );
    });
  }
});

test("network failures are sanitized and do not trigger retries or source fetches", async (t) => {
  const harness = await createSearchHarness(t);
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (input) => {
    attempts += 1;
    assert.equal(String(input), MCP_ENDPOINT);
    throw new TypeError("secret network diagnostic");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(runSearch(harness, { query: "network failure" }), (error) => {
    codeIs("NETWORK_ERROR")(error);
    assert.equal(error.message.includes("secret network diagnostic"), false);
    return true;
  });
  assert.equal(attempts, 1, "the failed connection must not be retried");
});

test("bounds evidence at 20,000 Unicode code points and rejects oversized MCP responses", async (t) => {
  const harness = await createSearchHarness(t);
  const longEvidence = "🧪snippet".repeat(3000);
  let responseMode = "evidence";
  const server = installMockExaServer(t, {
    onCall: (rpc) => {
      if (responseMode === "evidence") return defaultToolResult(longEvidence);
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text: "x".repeat(1_048_577) }] },
      });
      const headers = { "content-type": "application/json" };
      if (responseMode === "content-length") {
        headers["content-length"] = String(Buffer.byteLength(payload));
      }
      return new Response(payload, { headers });
    },
  });
  const result = await runSearch(harness, { query: "long evidence", limit: 1 });
  assert.equal(Array.from(result.structuredContent.evidenceText).length, 20_000);
  assert.equal(result.structuredContent.truncated, true);
  assert.equal(
    result.structuredContent.evidenceText,
    Array.from(longEvidence).slice(0, 20_000).join(""),
  );
  assert.equal(callRequests(server.calls).length, 1);

  responseMode = "oversized";
  await assert.rejects(
    runSearch(harness, { query: "oversized response" }),
    codeIs("RESPONSE_TOO_LARGE"),
  );
  assert.equal(callRequests(server.calls).length, 2);

  responseMode = "content-length";
  await assert.rejects(
    runSearch(harness, { query: "oversized content length" }),
    codeIs("RESPONSE_TOO_LARGE"),
  );
  assert.equal(callRequests(server.calls).length, 3);
});

test("an already-aborted call makes no request and in-flight cancellation is prompt", async (t) => {
  const harness = await createSearchHarness(t);
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let upstreamAborted = false;
  const server = installMockExaServer(t, {
    onCall: (_rpc, { request }) =>
      new Promise((resolve, reject) => {
        const signal = request.signal;
        if (signal?.aborted) {
          upstreamAborted = true;
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            upstreamAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
        markStarted();
        const fallback = realSetTimeout(
          () => resolve(defaultToolResult("unexpected late success")),
          500,
        );
        signal?.addEventListener("abort", () => realClearTimeout(fallback), { once: true });
      }),
  });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    runSearch(harness, { query: "cancel before request" }, alreadyAborted.signal),
    codeIs("CANCELLED"),
  );
  assert.equal(server.calls.length, 0);
  const controller = new AbortController();
  const pending = runSearch(harness, { query: "cancel while waiting" }, controller.signal);
  const cancellation = assert.rejects(pending, codeIs("CANCELLED"));
  await started;
  controller.abort();
  await cancellation;
  assert.equal(upstreamAborted, true);
  assert.equal(callRequests(server.calls).length, 1);
});

test("session shutdown cancels the active provider call", async (t) => {
  const harness = await createSearchHarness(t);
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let upstreamAborted = false;
  const server = installMockExaServer(t, {
    onCall: (_rpc, { request }) =>
      new Promise((resolve, reject) => {
        const signal = request.signal;
        signal?.addEventListener(
          "abort",
          () => {
            upstreamAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
        markStarted();
        const fallback = realSetTimeout(
          () => resolve(defaultToolResult("unexpected late success")),
          500,
        );
        signal?.addEventListener("abort", () => realClearTimeout(fallback), { once: true });
      }),
  });
  const pending = runSearch(harness, { query: "cancel on reload" });
  const cancellation = assert.rejects(pending, codeIs("CANCELLED"));
  await started;
  await harness.runner.emit({ type: "session_shutdown", reason: "reload" });
  await cancellation;
  assert.equal(upstreamAborted, true);
  assert.equal(callRequests(server.calls).length, 1);
});

test("the whole operation times out after 30 seconds", async (t) => {
  const harness = await createSearchHarness(t);
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let upstreamAborted = false;
  const server = installMockExaServer(t, {
    onCall: (_rpc, { request }) =>
      new Promise((resolve, reject) => {
        const signal = request.signal;
        signal?.addEventListener(
          "abort",
          () => {
            upstreamAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
        markStarted();
        const fallback = realSetTimeout(
          () => resolve(defaultToolResult("unexpected late success")),
          1200,
        );
        signal?.addEventListener("abort", () => realClearTimeout(fallback), { once: true });
      }),
  });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = runSearch(harness, { query: "timeout during provider call" });
  const timeout = assert.rejects(pending, codeIs("TIMEOUT"));
  await started;
  t.mock.timers.tick(30_001);
  await timeout;
  assert.equal(upstreamAborted, true);
  assert.equal(callRequests(server.calls).length, 1);
});
