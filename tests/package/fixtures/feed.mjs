export const feedUrl = "https://example.com/feed.xml";
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
