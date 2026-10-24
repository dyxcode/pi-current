import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

export const PUBLIC_IP = "93.184.216.34";
export const articleText =
  "Reading public articles locally preserves useful evidence. The experiment compared several methods, measured their output, and reported limitations. 中文正文也应该保留。 ";
export const articleHtml = `<!doctype html><html lang="en"><head><title>Evidence article</title><meta name="author" content="Fixture Author"></head><body><nav>UNRELATED NAVIGATION</nav><article><h1>Evidence article</h1>${Array.from({ length: 12 }, () => `<p>${articleText}</p>`).join("")}</article><script>document.querySelector("article").textContent = "SCRIPT_EXECUTED";</script><img src="https://tracker.example/image"><iframe src="http://127.0.0.1/private"></iframe></body></html>`;

/** Synthetic DNS/socket seam; parsing and the Pi tool remain real. */
export function mockPages(
  t,
  {
    lookup = async () => [{ address: PUBLIC_IP, family: 4 }],
    response = () => ({ body: articleHtml }),
  } = {},
) {
  const requests = [];
  const lookups = [];
  t.mock.method(dns, "lookup", async (...args) => {
    lookups.push(args);
    return lookup(...args);
  });
  const request = (url, options, onResponse) => {
    const record = {
      url: new URL(url),
      options,
      addresses: [],
      destroyed: false,
      response: undefined,
    };
    requests.push(record);
    const req = new EventEmitter();
    req.destroy = (error) => {
      if (record.destroyed) return req;
      record.destroyed = true;
      record.response?.destroy(error);
      if (error) queueMicrotask(() => req.emit("error", error));
      return req;
    };
    req.end = () => {
      queueMicrotask(async () => {
        try {
          const host = record.url.hostname.replace(/^\[|\]$/g, "");
          if (options.lookup) {
            record.addresses = await new Promise((resolve, reject) =>
              options.lookup(host, { all: true }, (error, addresses) =>
                error ? reject(error) : resolve(addresses),
              ),
            );
          }
          const result = await response(record);
          if (record.destroyed || !result) return;
          const body =
            result.stream ??
            Readable.from([
              Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body ?? ""),
            ]);
          body.statusCode = result.status ?? 200;
          body.headers = { "content-type": "text/html; charset=utf-8", ...result.headers };
          record.response = body;
          onResponse(body);
        } catch (error) {
          req.destroy(error);
        }
      });
      return req;
    };
    if (options.signal?.aborted) req.destroy(new Error("aborted"));
    else
      options.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")), {
        once: true,
      });
    return req;
  };
  t.mock.method(http, "request", request);
  t.mock.method(https, "request", request);
  return { requests, lookups };
}

export function assertReadError(code) {
  return (error) => {
    assert.match(error.message, new RegExp(`^${code}:`));
    return true;
  };
}
