import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { ClientRequest, IncomingMessage, IncomingHttpHeaders } from "node:http";
import { isIP, type LookupFunction } from "node:net";
import type { Readable, Transform } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import ipaddr from "ipaddr.js";
import { abortable, abortFailure, MAX_PAGE_BYTES, ReadError } from "./read-types.ts";

export type DownloadedPage = {
  bytes: Uint8Array;
  finalUrl: string;
  contentType: string;
  partial: boolean;
};
type HttpReply = { status: number; headers: IncomingHttpHeaders; bytes: Buffer };
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function publicAddress(address: string): boolean {
  if (!isIP(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== "unicast") return false;
  // Only allocated global unicast space; also excludes mapped/transition forms.
  return parsed.kind() === "ipv4" || parsed.match(ipaddr.parse("2000::"), 3);
}

function assertPublicUrl(url: URL): void {
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    !host ||
    (isIP(host) !== 0 && !publicAddress(host))
  ) {
    throw new ReadError(
      "BLOCKED_URL",
      "Only public HTTP(S) destinations on their standard ports are allowed.",
    );
  }
}

async function resolvePublic(url: URL, signal: AbortSignal): Promise<LookupAddress> {
  assertPublicUrl(url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: LookupAddress[];
  try {
    const family = isIP(host);
    addresses = family
      ? [{ address: host, family }]
      : await abortable(dns.lookup(host, { all: true, verbatim: true }), signal);
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError("NETWORK_ERROR", "Could not resolve the page host.");
  }
  if (signal.aborted) throw abortFailure(signal);
  if (
    !addresses.length ||
    addresses.some((entry) => !publicAddress(entry.address) || isIP(entry.address) !== entry.family)
  ) {
    throw new ReadError(
      "BLOCKED_URL",
      "The page host resolves to a non-public or invalid destination.",
    );
  }
  // A single checked address is used by the socket; no second DNS lookup or retry.
  return addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
}

/** Low-level connector: caller supplies an address validated for this URL/hop. */
export function requestPage(
  url: URL,
  address: LookupAddress,
  signal: AbortSignal,
): Promise<HttpReply> {
  if (signal.aborted) return Promise.reject(abortFailure(signal));
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let decoded: Readable | undefined;
    let settled = false;
    const finish = (error?: ReadError, result?: HttpReply) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      decoded?.destroy();
      response?.destroy();
      request?.destroy();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const onAbort = () => finish(abortFailure(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    };
    try {
      request = (url.protocol === "https:" ? https : http).request(
        url,
        {
          method: "GET",
          agent: false,
          lookup,
          family: address.family,
          signal,
          headers: {
            accept: "text/html, text/plain, text/markdown;q=0.9",
            "accept-encoding": "gzip, deflate, br",
            "user-agent": "pi-current/0.0.0",
          },
        },
        (incoming) => {
          response = incoming;
          const status = incoming.statusCode ?? 0;
          if (REDIRECTS.has(status)) {
            finish(undefined, { status, headers: incoming.headers, bytes: Buffer.alloc(0) });
            return;
          }
          if (status === 401 || status === 403) {
            finish(new ReadError("ACCESS_DENIED", `The website denied access (HTTP ${status}).`));
            return;
          }
          if (status === 429) {
            finish(
              new ReadError("RATE_LIMITED", "The website is rate limiting requests. Try later."),
            );
            return;
          }
          if (status !== 200 && status !== 206) {
            finish(new ReadError("HTTP_ERROR", `The website returned HTTP ${status}.`));
            return;
          }
          const mime = incoming.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
          if (!mime || !["text/html", "text/plain", "text/markdown"].includes(mime)) {
            finish(
              new ReadError(
                "UNSUPPORTED_CONTENT",
                "Only HTML, plain text and Markdown pages are supported.",
              ),
            );
            return;
          }
          if (Number(incoming.headers["content-length"]) > MAX_PAGE_BYTES) {
            finish(new ReadError("RESPONSE_TOO_LARGE", "The response exceeds the 2 MiB limit."));
            return;
          }
          const encoding = incoming.headers["content-encoding"]?.trim().toLowerCase() ?? "identity";
          let decompressor: Transform | undefined;
          switch (encoding) {
            case "identity":
              break;
            case "gzip":
              decompressor = createGunzip();
              break;
            case "deflate":
              decompressor = createInflate();
              break;
            case "br":
              decompressor = createBrotliDecompress();
              break;
            default:
              finish(
                new ReadError("UNSUPPORTED_ENCODING", "The response compression is unsupported."),
              );
              return;
          }
          decoded = decompressor ?? incoming;
          const chunks: Buffer[] = [];
          let bytes = 0;
          let wireBytes = 0;
          incoming.on("data", (chunk: Buffer) => {
            wireBytes += chunk.length;
            if (wireBytes > MAX_PAGE_BYTES)
              finish(new ReadError("RESPONSE_TOO_LARGE", "The response exceeds the 2 MiB limit."));
          });
          incoming.on("aborted", () =>
            finish(new ReadError("NETWORK_ERROR", "The page response was interrupted.")),
          );
          incoming.on("error", () =>
            finish(
              signal.aborted
                ? abortFailure(signal)
                : new ReadError("NETWORK_ERROR", "The page response was interrupted."),
            ),
          );
          decoded.on("error", () =>
            finish(new ReadError("NETWORK_ERROR", "Could not decode the page response.")),
          );
          decoded.on("data", (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > MAX_PAGE_BYTES) {
              finish(
                new ReadError(
                  "RESPONSE_TOO_LARGE",
                  "The decoded response exceeds the 2 MiB limit.",
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          decoded.on("end", () =>
            finish(undefined, {
              status,
              headers: incoming.headers,
              bytes: Buffer.concat(chunks, bytes),
            }),
          );
          if (decompressor) incoming.pipe(decompressor);
        },
      );
      request.on("error", () =>
        finish(
          signal.aborted
            ? abortFailure(signal)
            : new ReadError("NETWORK_ERROR", "Could not connect to the page host."),
        ),
      );
      request.end();
    } catch {
      finish(new ReadError("NETWORK_ERROR", "Could not start the page request."));
    }
  });
}

export async function fetchPublicPage(input: string, signal: AbortSignal): Promise<DownloadedPage> {
  let url = new URL(input);
  const visited = new Set<string>();
  for (let hop = 0; hop <= 5; hop++) {
    if (signal.aborted) throw abortFailure(signal);
    assertPublicUrl(url);
    if (visited.has(url.href))
      throw new ReadError("REDIRECT_ERROR", "The website returned a redirect loop.");
    visited.add(url.href);
    const address = await resolvePublic(url, signal);
    const reply = await requestPage(url, address, signal);
    if (!REDIRECTS.has(reply.status)) {
      return {
        bytes: reply.bytes,
        finalUrl: url.href,
        contentType: reply.headers["content-type"]!,
        partial: reply.status === 206,
      };
    }
    if (hop === 5) throw new ReadError("REDIRECT_ERROR", "The page exceeded five redirects.");
    const location = reply.headers.location;
    if (!location || location.length > 8_192)
      throw new ReadError("REDIRECT_ERROR", "The website returned an invalid redirect.");
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new ReadError("REDIRECT_ERROR", "The website returned an invalid redirect.");
    }
    next.hash = "";
    assertPublicUrl(next);
    if (url.protocol === "https:" && next.protocol !== "https:") {
      throw new ReadError("BLOCKED_URL", "HTTPS redirects to HTTP are not allowed.");
    }
    url = next;
  }
  throw new ReadError("REDIRECT_ERROR", "The page exceeded five redirects.");
}
