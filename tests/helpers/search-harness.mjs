import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  SessionManager,
  SettingsManager,
  wrapRegisteredTools,
} from "@earendil-works/pi-coding-agent";

export const MCP_ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_exa";
const repoRoot = await realpath(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

export async function createSearchHarness(t, toolName = "current_web_search") {
  const root = await mkdtemp(join(tmpdir(), "pi-current-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({
      packages: [repoRoot],
      enableInstallTelemetry: false,
      enableAnalytics: false,
    }),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, [], "Pi must load the extension without errors");
  const extension = loaded.extensions.find(
    (candidate) => candidate.resolvedPath === join(repoRoot, "src", "index.ts"),
  );
  assert.ok(extension, "Pi's real loader must discover src/index.ts");

  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    cwd,
    SessionManager.create(cwd, sessionDir),
    {},
  );
  runner.bindCore(
    {
      sendMessage() {},
      sendUserMessage() {},
      appendEntry() {},
      setSessionName() {},
      getSessionName: () => undefined,
      setLabel() {},
      getActiveTools: () => [],
      getAllTools: () => [],
      getSettings: () => ({}),
      setActiveTools() {},
      refreshTools() {},
      getCommands: () => [],
      setModel: async () => undefined,
      getThinkingLevel: () => "normal",
      setThinkingLevel() {},
    },
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort() {},
      hasPendingMessages: () => false,
      shutdown() {},
      getContextUsage: () => undefined,
      compact() {},
      getSystemPrompt: () => "",
    },
  );

  const registered = runner.getAllRegisteredTools();
  assert.deepEqual(
    registered
      .map((tool) => tool.definition.name)
      .filter((name) => name.startsWith("current_web_")),
    ["current_web_search", "current_web_read"],
    "the real Pi runner must expose the search and read tools exactly once",
  );
  const tool = wrapRegisteredTools(registered, runner).find((tool) => tool.name === toolName);
  assert.ok(tool, "Pi must wrap the registered search tool");
  return { cwd, loader, runner, tool, root, extension, registered };
}

export function installMockExaServer(
  t,
  { onCall = () => defaultToolResult(), endpoint = MCP_ENDPOINT, initializedBody = null } = {},
) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : String(input));
    const method = init.method ?? request?.method ?? "GET";
    const headers = new Headers(init.headers ?? request?.headers);
    const signal = init.signal ?? request?.signal;
    const body =
      init.body ?? (request && method !== "GET" ? await request.clone().text() : undefined);
    const rpc = typeof body === "string" ? JSON.parse(body) : undefined;
    calls.push({ url: url.href, method, headers, body, rpc, signal });

    if (url.href !== endpoint) {
      throw new Error(`Unexpected network destination in fixture: ${url.href}`);
    }
    if (method === "GET") return new Response("", { status: 405 });
    if (method !== "POST" || !rpc) return new Response("", { status: 405 });
    if (rpc.method === "notifications/initialized")
      return new Response(initializedBody, { status: 202 });
    if (rpc.method === "initialize") {
      return jsonRpcResponse({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "synthetic-exa", version: "1.0.0" },
        },
      });
    }
    if (rpc.method === "tools/list") {
      return jsonRpcResponse({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          tools: [
            {
              name: "web_search_exa",
              description: "Synthetic fixture",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  numResults: { type: "integer" },
                },
                required: ["query", "numResults"],
              },
            },
          ],
        },
      });
    }
    if (rpc.method === "tools/call") {
      const response = await onCall(rpc, { calls, request: calls.at(-1) });
      if (response instanceof Response) return response;
      if (response?.eventStream)
        return sseRpcResponse({ jsonrpc: "2.0", id: rpc.id, result: response.result });
      return jsonRpcResponse({ jsonrpc: "2.0", id: rpc.id, result: response?.result ?? response });
    }
    if (rpc.id !== undefined) {
      return jsonRpcResponse({
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: "fixture method not found" },
      });
    }
    return new Response(null, { status: 202 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return { calls };
}

export function defaultToolResult(text = syntheticEvidenceText()) {
  return {
    content: [{ type: "text", text }],
    isError: false,
  };
}

export function syntheticEvidenceText() {
  return [
    "Title: Synthetic result",
    "URL: https://example.com/synthetic-result",
    "Highlights: Synthetic excerpt for contract tests.",
    "Note: Synthetic notice must be preserved.",
  ].join("\n");
}

export function jsonRpcResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function sseRpcResponse(payload) {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
