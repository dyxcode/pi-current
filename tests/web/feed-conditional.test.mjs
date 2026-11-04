import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPublicPage } from "../../src/web/http-page.ts";
import { mockPages } from "../helpers/page-harness.mjs";

const url = "https://example.com/feed";

test("feed revalidation sends validators and accepts a bodyless 304", async (t) => {
  const { requests } = mockPages(t, {
    response: () => ({ status: 304, headers: { etag: '"v2"' } }),
  });
  const validators = { url, etag: '"v1"', lastModified: "Tue, 03 Nov 2026 00:00:00 GMT" };
  const result = await fetchPublicPage(url, new AbortController().signal, "feed", validators);
  assert.equal(requests[0].options.headers["if-none-match"], validators.etag);
  assert.equal(requests[0].options.headers["if-modified-since"], validators.lastModified);
  assert.equal(result.notModified, true);
  assert.equal(result.bytes.length, 0);
  assert.deepEqual(result.validators, { ...validators, etag: '"v2"' });
});

test("validators apply only to the exact previously fetched URL through redirects", async (t) => {
  const finalUrl = "https://example.com/current-feed";
  const { requests } = mockPages(t, {
    response: ({ url: requested }) =>
      requested.href === url ? { status: 302, headers: { location: finalUrl } } : { status: 304 },
  });
  await fetchPublicPage(url, new AbortController().signal, "feed", { url: finalUrl, etag: '"v1"' });
  assert.equal(requests[0].options.headers["if-none-match"], undefined);
  assert.equal(requests[1].options.headers["if-none-match"], '"v1"');
});

test("a changed representation supplies replacement validators and an unconditional 304 is rejected", async (t) => {
  const { requests } = mockPages(t, {
    response: () => ({
      body: "<rss/>",
      headers: {
        "content-type": "application/rss+xml",
        "last-modified": "Wed, 04 Nov 2026 00:00:00 GMT",
      },
    }),
  });
  const result = await fetchPublicPage(url, new AbortController().signal, "feed", {
    url,
    etag: '"old"',
  });
  assert.equal(result.notModified, undefined);
  assert.deepEqual(result.validators, { url, lastModified: "Wed, 04 Nov 2026 00:00:00 GMT" });
  assert.equal(requests.length, 1);
});

test("304 without a matching conditional request is an HTTP error", async (t) => {
  mockPages(t, { response: () => ({ status: 304 }) });
  await assert.rejects(fetchPublicPage(url, new AbortController().signal, "feed"), /HTTP_ERROR/);
  await assert.rejects(fetchPublicPage(url, new AbortController().signal), /HTTP_ERROR/);
  await assert.rejects(
    fetchPublicPage(url, new AbortController().signal, "feed", {
      url: "https://other.example/feed",
      etag: '"v1"',
    }),
    /HTTP_ERROR/,
  );
});

test("Last-Modified alone revalidates and validators are not forwarded to a different URL", async (t) => {
  const lastModified = "Tue, 03 Nov 2026 00:00:00 GMT";
  let redirect = false;
  const { requests } = mockPages(t, {
    response: ({ url: requested }) => {
      if (!redirect) return { status: 304 };
      return requested.href === url
        ? { status: 302, headers: { location: "https://other.example/new-feed" } }
        : { body: "<rss/>", headers: { "content-type": "application/rss+xml" } };
    },
  });
  const validators = { url, lastModified };
  const unchanged = await fetchPublicPage(url, new AbortController().signal, "feed", validators);
  assert.equal(unchanged.notModified, true);
  assert.equal(requests[0].options.headers["if-none-match"], undefined);
  assert.equal(requests[0].options.headers["if-modified-since"], lastModified);
  redirect = true;
  const changed = await fetchPublicPage(url, new AbortController().signal, "feed", validators);
  assert.equal(requests[2].options.headers["if-modified-since"], undefined);
  assert.equal(changed.validators, undefined);
});

test("an unusable optional validator does not reject the feed body", async (t) => {
  mockPages(t, {
    response: () => ({
      body: "<rss/>",
      headers: { "content-type": "application/rss+xml", etag: "x".repeat(9_000) },
    }),
  });
  const page = await fetchPublicPage(url, new AbortController().signal, "feed");
  assert.equal(Buffer.from(page.bytes).toString(), "<rss/>");
  assert.equal(page.validators, undefined);
});
