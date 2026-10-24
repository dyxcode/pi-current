// A trusted local source plugin. This example uses synthetic content and no network.
export default {
  apiVersion: 1,
  id: "sample",
  name: "Sample source",
  hosts: ["example.com"],
  capabilities: { login: false, check: true, read: true, collect: true },
  async create({ sourceId }) {
    const item = (url) => ({
      sourceId,
      externalId: "sample-article",
      url,
      title: "A sample article",
      text: "This is synthetic content for trying the source interface.",
      retrievedAt: new Date().toISOString(),
      sourceCompleteness: "unknown",
      truncated: false,
    });
    const cancelled = (signal) => {
      if (signal.aborted) throw new Error("CANCELLED");
    };
    return {
      async check(signal) {
        cancelled(signal);
        return "not-required";
      },
      async read(url, _maxCharacters, signal) {
        cancelled(signal);
        return item(url);
      },
      async collect(_limit, signal) {
        cancelled(signal);
        return {
          items: [item("https://example.com/article")],
          failures: [],
          stopReason: "complete",
        };
      },
      async close() {},
    };
  },
};
