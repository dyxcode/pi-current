import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import workerThreads from "node:worker_threads";
import { once } from "node:events";
import { requestPage } from "../src/web/http-page.ts";
import { createSearchHarness } from "./helpers/search-harness.mjs";
import { mockPages, articleHtml, assertReadError } from "./helpers/page-harness.mjs";

async function localServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

test("native HTTP connects to the pinned address while retaining the original Host", async (t) => {
  let receivedHost;
  const port = await localServer(t, (req, res) => {
    receivedHost = req.headers.host;
    res.setHeader("content-type", "text/plain");
    res.end("Pinned connection verified.");
  });
  // The low-level connector accepts a prevalidated address. Production's public
  // URL/DNS boundary rejects loopback; no user-facing test bypass is introduced.
  const result = await requestPage(
    new URL(`http://does-not-resolve.invalid:${port}/article`),
    { address: "127.0.0.1", family: 4 },
    AbortSignal.timeout(2000),
  );
  assert.equal(result.bytes.toString(), "Pinned connection verified.");
  assert.equal(receivedHost, `does-not-resolve.invalid:${port}`);
});

test("real parser worker does not load scripts, images, styles or frames", async (t) => {
  let requests = 0;
  const port = await localServer(t, (_req, res) => {
    requests++;
    res.end("UNEXPECTED_SUBRESOURCE");
  });
  const page =
    articleHtml +
    `<iframe src="http://127.0.0.1:${port}/frame"></iframe><img src="http://127.0.0.1:${port}/image"><link rel="stylesheet" href="http://127.0.0.1:${port}/style"><script src="http://127.0.0.1:${port}/script"></script>`;
  mockPages(t, { response: () => ({ body: page }) });
  const harness = await createSearchHarness(t, "current_web_read");
  const result = await harness.tool.execute("isolated-parser", {
    url: "https://example.com/article",
  });
  assert.match(result.structuredContent.text, /Reading public articles/);
  assert.doesNotMatch(result.structuredContent.text, /SCRIPT_EXECUTED|UNEXPECTED_SUBRESOURCE/);
  assert.equal(requests, 0);
});

test("caller cancellation, deadline and reload terminate an actually busy parser worker", async (t) => {
  for (const mode of ["cancel", "timeout", "reload"])
    await t.test(mode, async (st) => {
      const { Worker } = workerThreads;
      let started;
      const online = new Promise((resolve) => {
        started = resolve;
      });
      let parser;
      // biome-ignore lint/complexity/useArrowFunction: The Worker constructor mock must remain constructible.
      st.mock.method(workerThreads, "Worker", function () {
        parser = new Worker("while (true) {}", { eval: true, execArgv: [] });
        parser.once("online", started);
        return parser;
      });
      mockPages(st);
      const harness = await createSearchHarness(st, "current_web_read");
      const controller = new AbortController();
      if (mode === "timeout") st.mock.timers.enable({ apis: ["setTimeout"] });
      const rejected = assert.rejects(
        harness.tool.execute(
          "busy-parser",
          { url: "https://example.com/article" },
          controller.signal,
        ),
        assertReadError(mode === "timeout" ? "TIMEOUT" : "CANCELLED"),
      );
      await online;
      if (mode === "timeout") st.mock.timers.tick(30_001);
      else if (mode === "reload")
        await harness.runner.emit({ type: "session_shutdown", reason: "reload" });
      else controller.abort();
      await rejected;
      assert.equal(parser.threadId, -1, "the worker must have exited before the tool settles");
    });
});

test("legacy text encoding is decoded and partial HTTP content stays explicitly partial", async (t) => {
  mockPages(t, {
    response: () => ({
      status: 206,
      body: Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      headers: { "content-type": "text/plain; charset=gbk", "content-range": "bytes 0-3/40" },
    }),
  });
  const harness = await createSearchHarness(t, "current_web_read");
  const result = await harness.tool.execute("gbk", { url: "https://example.com/text" });
  assert.equal(result.structuredContent.text, "中文");
  assert.equal(result.structuredContent.sourceCompleteness, "known-partial");
  assert.equal(result.structuredContent.truncated, false);
});

test("article extraction flags access prompts without asserting complete source coverage", async (t) => {
  mockPages(t, {
    response: () => ({ body: `${articleHtml}<aside>Subscribe to continue reading.</aside>` }),
  });
  const harness = await createSearchHarness(t, "current_web_read");
  const result = await harness.tool.execute("preview", { url: "https://example.com/article" });
  assert.match(result.structuredContent.text, /Reading public articles/);
  assert.equal(result.structuredContent.sourceCompleteness, "unknown");
  assert.ok(result.structuredContent.warnings.some((warning) => warning.includes("preview")));
});
