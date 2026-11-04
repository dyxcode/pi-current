export const feedUrl = "https://example.com/feed.xml";
export const feedEtag = '"fixture-feed-v1"';
export const feedLastModified = "Tue, 03 Nov 2026 00:00:00 GMT";
export const feedXml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
  <title>Package fixture</title>
  <item><guid>article</guid><title>Synthetic article</title><link>https://example.com/article</link>
    <content:encoded><![CDATA[<p>Synthetic independent feed content.</p>]]></content:encoded>
  </item>
  <item><guid>candidate</guid><title>Synthetic candidate</title><link>https://example.com/candidate</link>
    <description>A synthetic source summary.</description>
  </item>
</channel></rss>`;

export function feedResponse(record) {
  const headers = Object.fromEntries(
    Object.entries(record.options.headers ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  const unchanged =
    headers["if-none-match"] === feedEtag || headers["if-modified-since"] === feedLastModified;
  return {
    ...(unchanged ? { status: 304, body: "" } : { body: feedXml }),
    headers: {
      "content-type": "application/rss+xml",
      etag: feedEtag,
      "last-modified": feedLastModified,
    },
  };
}

export function hasConditionalValidator(record) {
  const headers = Object.fromEntries(
    Object.entries(record.options.headers ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  return headers["if-none-match"] === feedEtag || headers["if-modified-since"] === feedLastModified;
}
