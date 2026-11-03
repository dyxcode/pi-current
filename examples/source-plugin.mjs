// A source module returns content; pi-current assigns identity and saves the import.
// This example uses synthetic content and performs no network requests.
export default {
  id: "sample",
  name: "Sample source",
  async fetch({ url, limit }, { signal }) {
    signal.throwIfAborted();
    const now = new Date().toISOString();
    return {
      items: [
        {
          externalId: "sample-article",
          url: new URL("/article", url).href,
          title: "A synthetic article",
          text: "This is synthetic content for trying the source interface.",
          discoveredAt: now,
          retrievedAt: now,
          sourceCompleteness: "unknown",
          truncated: false,
        },
        {
          externalId: "sample-candidate",
          url: new URL("/candidate", url).href,
          title: "A synthetic candidate",
          summary: "This entry supplies a summary and link without an article body.",
          discoveredAt: now,
        },
      ].slice(0, limit),
      issues: [],
    };
  },
};
