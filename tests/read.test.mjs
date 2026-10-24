import assert from "node:assert/strict";
import { test } from "node:test";
import { createSearchHarness } from "./helpers/search-harness.mjs";

test("Pi exposes public-page reading with a separate input and output contract", async (t) => {
  const { tool } = await createSearchHarness(t, "current_web_read");
  assert.equal(tool.name, "current_web_read");
  assert.ok(tool.parameters.properties.url);
  assert.ok(tool.outputSchema.anyOf[0].properties.finalUrl);
  assert.deepEqual(tool.prepareArguments({ url: " https://example.com/article#section " }), {
    url: "https://example.com/article",
    maxCharacters: 20_000,
  });
});

import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { articleHtml, mockPages, PUBLIC_IP, assertReadError } from "./helpers/page-harness.mjs";

async function invoke(t, args, signal) {
  const harness = await createSearchHarness(t, "current_web_read");
  return harness.tool.execute("read-fixture", args, signal);
}

test("extracts HTML locally, preserves provenance, and never requests subresources", async (t) => {
  const net = mockPages(t);
  const result = await invoke(t, { url: "https://example.com/article#section" });
  const data = result.structuredContent;
  assert.equal(data.requestedUrl, "https://example.com/article");
  assert.equal(data.finalUrl, data.requestedUrl);
  assert.equal(data.retrievalMethod, "direct-http");
  assert.equal(data.contentKind, "extracted-article");
  assert.equal(data.sourceCompleteness, "unknown");
  assert.equal(data.truncated, false);
  assert.equal(data.title, "Evidence article");
  assert.equal(data.byline, "Fixture Author");
  assert.match(result.content[0].text, /Page-supplied author: Fixture Author/);
  assert.match(data.text, /中文正文/);
  assert.doesNotMatch(data.text, /UNRELATED NAVIGATION|pageExecuted/);
  assert.match(result.content[0].text, /untrusted/i);
  assert.equal(globalThis.pageExecuted, undefined);
  assert.equal(net.requests.length, 1);
  assert.deepEqual(net.requests[0].addresses, [{ address: PUBLIC_IP, family: 4 }]);
  assert.equal(net.requests[0].options.agent, false);
  assert.equal(net.requests[0].options.headers.authorization, undefined);
  assert.equal(net.requests[0].options.headers.cookie, undefined);
  assert.ok(Number.isFinite(Date.parse(data.retrievedAt)));
});

test("preserves text and Markdown, limits Unicode output, and labels truncation", async (t) => {
  const original = `# 原文\n\n${"🧪内容".repeat(1000)}`;
  mockPages(t, {
    response: () => ({
      body: original,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    }),
  });
  const result = await invoke(t, { url: "https://example.com/doc.md", maxCharacters: 1000 });
  const data = result.structuredContent;
  assert.equal(data.contentKind, "plain-text");
  assert.equal(data.text, [...original].slice(0, 1000).join(""));
  assert.equal(data.truncated, true);
  assert.equal(data.sourceCompleteness, "unknown");
});

test("rejects invalid input and non-public literal destinations without connecting", async (t) => {
  const net = mockPages(t);
  for (const args of [
    { url: `https://example.com/${"中".repeat(2000)}` },
    { url: "file:///etc/passwd" },
    { url: "https://user:pass@example.com/" },
    { url: "https://example.com", maxCharacters: 999 },
    { url: "https://example.com", maxCharacters: 50001 },
    { url: "https://example.com", maxCharacters: 1.5 },
    { url: "https://example.com", extra: true },
  ])
    await assert.rejects(invoke(t, args), assertReadError("INVALID_INPUT"));
  for (const url of [
    "http://localhost/",
    "http://127.1/",
    "http://0x7f000001/",
    "http://10.0.0.1/",
    "http://169.254.169.254/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fc00::1]/",
    "http://192.0.2.1/",
    "http://example.com:8080/",
  ])
    await assert.rejects(invoke(t, { url }), assertReadError("BLOCKED_URL"));
  assert.equal(net.requests.length, 0);
});

test("rejects mixed public/private DNS answers before connecting", async (t) => {
  const net = mockPages(t, {
    lookup: async () => [
      { address: PUBLIC_IP, family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
  });
  await assert.rejects(invoke(t, { url: "https://example.com" }), assertReadError("BLOCKED_URL"));
  assert.equal(net.requests.length, 0);
});

test("validates each redirect and uses only the initially validated address for each hop", async (t) => {
  const net = mockPages(t, {
    response: (record) =>
      record.url.pathname === "/start"
        ? { status: 302, headers: { location: "/article" } }
        : { body: articleHtml },
  });
  const data = (await invoke(t, { url: "https://example.com/start" })).structuredContent;
  assert.equal(data.finalUrl, "https://example.com/article");
  assert.equal(net.requests.length, 2);
  assert.equal(net.lookups.length, 2);
  for (const req of net.requests)
    assert.deepEqual(req.addresses, [{ address: PUBLIC_IP, family: 4 }]);
});

test("rejects redirect-to-private, HTTPS downgrade, loops, and too many hops", async (t) => {
  for (const scenario of [
    { location: "http://127.0.0.1/private", code: "BLOCKED_URL" },
    { location: "http://example.com/plain", code: "BLOCKED_URL" },
    { location: "https://example.com/start", code: "REDIRECT_ERROR" },
    { location: "ftp://example.com/file", code: "BLOCKED_URL" },
  ])
    await t.test(scenario.location, async (st) => {
      const net = mockPages(st, {
        response: () => ({ status: 302, headers: { location: scenario.location } }),
      });
      await assert.rejects(
        invoke(st, { url: "https://example.com/start" }),
        assertReadError(scenario.code),
      );
      assert.equal(net.requests.length, 1);
    });
  await t.test("hop limit", async (st) => {
    const net = mockPages(st, {
      response: (record) => ({
        status: 302,
        headers: { location: `/${Number(record.url.pathname.slice(1)) + 1}` },
      }),
    });
    await assert.rejects(
      invoke(st, { url: "https://example.com/0" }),
      assertReadError("REDIRECT_ERROR"),
    );
    assert.equal(net.requests.length, 6);
  });
});

test("reports access restrictions, unsupported content, HTTP errors, and empty pages explicitly", async (t) => {
  for (const scenario of [
    { response: { status: 401, body: "secret detail" }, code: "ACCESS_DENIED" },
    { response: { status: 403, body: "secret detail" }, code: "ACCESS_DENIED" },
    { response: { status: 429, body: "secret detail" }, code: "RATE_LIMITED" },
    { response: { status: 500, body: "secret detail" }, code: "HTTP_ERROR" },
    {
      response: { body: "%PDF", headers: { "content-type": "application/pdf" } },
      code: "UNSUPPORTED_CONTENT",
    },
    { response: { body: "<html><body></body></html>" }, code: "NO_READABLE_CONTENT" },
    {
      response: {
        body: "<html><body><form><input type=password>Sign in to read this article</form></body></html>",
      },
      code: "ACCESS_REQUIRED",
    },
    {
      response: {
        body: "<html><title>Verify you are human</title><body>Please complete the CAPTCHA</body></html>",
      },
      code: "ACCESS_REQUIRED",
    },
  ])
    await t.test(scenario.code, async (st) => {
      mockPages(st, { response: () => scenario.response });
      await assert.rejects(invoke(st, { url: "https://example.com/article" }), (error) => {
        assertReadError(scenario.code)(error);
        assert.doesNotMatch(error.message, /secret detail/);
        return true;
      });
    });
});

test("caps decoded response bytes including compressed and chunked bodies", async (t) => {
  for (const compressed of [false, true])
    await t.test(String(compressed), async (st) => {
      const text = "x".repeat(2 * 1024 * 1024 + 1);
      mockPages(st, {
        response: () => ({
          body: compressed ? gzipSync(text) : text,
          headers: {
            "content-type": "text/plain",
            ...(compressed ? { "content-encoding": "gzip" } : {}),
          },
        }),
      });
      await assert.rejects(
        invoke(st, { url: "https://example.com/large" }),
        assertReadError("RESPONSE_TOO_LARGE"),
      );
    });
});

test("pre-cancellation makes no request and shutdown cancels pending reads", async (t) => {
  const net = mockPages(t, { response: () => undefined });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    invoke(t, { url: "https://example.com" }, controller.signal),
    assertReadError("CANCELLED"),
  );
  assert.equal(net.requests.length, 0);
  const harness = await createSearchHarness(t, "current_web_read");
  const pending = harness.tool.execute("pending", { url: "https://example.com" });
  const rejected = assert.rejects(pending, assertReadError("CANCELLED"));
  await new Promise((resolve) => setImmediate(resolve));
  await harness.runner.emit({ type: "session_shutdown", reason: "reload" });
  await rejected;
  assert.equal(net.requests[0].destroyed, true);
});

test("whole-operation deadline also covers stalled DNS", async (t) => {
  const harness = await createSearchHarness(t, "current_web_read");
  const net = mockPages(t, { lookup: () => new Promise(() => {}) });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = assert.rejects(
    harness.tool.execute("timeout", { url: "https://example.com" }),
    assertReadError("TIMEOUT"),
  );
  t.mock.timers.tick(30_001);
  await rejected;
  assert.equal(net.requests.length, 0);
});

test("DNS and response-stream failures are sanitized without retries", async (t) => {
  await t.test("DNS", async (st) => {
    const net = mockPages(st, {
      lookup: async () => {
        throw new Error("private DNS diagnostics");
      },
    });
    await assert.rejects(invoke(st, { url: "https://example.com/article" }), (error) => {
      assertReadError("NETWORK_ERROR")(error);
      assert.doesNotMatch(error.message, /private DNS/);
      return true;
    });
    assert.equal(net.requests.length, 0);
  });
  await t.test("interrupted response", async (st) => {
    const stream = new Readable({
      read() {
        this.destroy(new Error("private upstream diagnostics"));
      },
    });
    const net = mockPages(st, { response: () => ({ stream }) });
    await assert.rejects(invoke(st, { url: "https://example.com/article" }), (error) => {
      assertReadError("NETWORK_ERROR")(error);
      assert.doesNotMatch(error.message, /private upstream/);
      return true;
    });
    assert.equal(net.requests.length, 1);
  });
  await t.test("unsupported text encoding", async (st) => {
    mockPages(st, {
      response: () => ({
        body: "text",
        headers: { "content-type": "text/plain; charset=unknown-fixture-encoding" },
      }),
    });
    await assert.rejects(
      invoke(st, { url: "https://example.com/article" }),
      assertReadError("UNSUPPORTED_ENCODING"),
    );
  });
});

test("redirect DNS cannot change from a public destination to an internal address", async (t) => {
  let resolutions = 0;
  const net = mockPages(t, {
    lookup: async () => [{ address: ++resolutions === 1 ? PUBLIC_IP : "10.0.0.1", family: 4 }],
    response: () => ({ status: 302, headers: { location: "/next" } }),
  });
  await assert.rejects(
    invoke(t, { url: "https://example.com/start" }),
    assertReadError("BLOCKED_URL"),
  );
  assert.equal(net.requests.length, 1);
});
