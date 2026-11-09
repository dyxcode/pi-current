# pi-current

English | [简体中文](docs/i18n/README.zh-CN.md)

**Search the web. Follow your interests.**

pi-current is a [Pi](https://github.com/earendil-works/pi) extension for public web search, feed-based reading discovery, and a local article library through conversation.

## Search and read

Ask Pi to search a topic, read a URL, or open a search result:

- “Search for recent articles about local-first software.”
- “Read the second result and explain its main argument.”

Search results include source links. Public page reading supports HTML, plain text, and Markdown.

## Find something to read

Ask Pi for a mixed reading list or a topic:

- “Show me today’s recommendations.”
- “Find five articles across technology, humanities, and everyday life.”
- “Find articles about urban life and loneliness.”

Pi prepares the current entries from your enabled feeds in the local library, then recommends five articles by default. Mixed reading alternates between sources, favoring recent entries within each source. Topic requests match words or phrases in titles and summaries, with title matches first. “Today’s recommendations” means a reading selection for today, not a filter for articles published today. The candidates come from current feed documents, not each publisher’s full archive.

The local reading cards show results in order, with the source, publication date when available, and matched terms for topic requests. Ask “Open the second article” to read its saved text. Entries with only a summary show that summary and the original link. A source failure is reported alongside available results. If an update fails, recommendations can use that source’s previous preparation with its preparation time shown in the source issue.

## Choose your sources

Ask Pi to find and add sources, for example: “Add a few sources about technology and humanities.” Pi can search for suitable feeds, validate their RSS/Atom URLs, and save them as enabled sources. A recommendation request uses your existing enabled sources. Adding an existing source keeps its name and enabled state.

Open `/source` to view source names, URLs, and enabled states, then enable or disable a source. Changes are saved automatically and update background preparation. Disabling a source excludes it from subsequent preparation and recommendations while keeping its saved articles. Enable it again to resume following it.

The default sources are [MIT Research](https://news.mit.edu/rss), [JSTOR Daily](https://daily.jstor.org/), and [Psyche](https://psyche.co/). They cover research and technology, humanities, and everyday psychology.

## Articles ready to read

At session startup, pi-current prepares enabled sources in the background. A recommendation request checks those sources for changes before selecting articles, sharing preparation already in progress. Changes in `/source` update the background preparation. Standalone Pi does not poll sources while idle, and background work stops when Pi closes.

Sources that provide ETag or Last-Modified headers are checked with conditional HTTP requests. An unchanged response reuses the persisted preparation without downloading and parsing another feed body. Sources without those headers are fetched normally. Prepared articles and HTTP validators survive Pi restarts.

Preparation fetches each source’s current RSS 2.0 or Atom 1.0 document, cleans feed-provided HTML, and saves its valid entries. The status line reports processed article counts and source issues. Unchanged articles reuse existing versions; changed content retains version history. A successful empty feed replaces that source’s current candidate set, while a failed update preserves its previous successful preparation. The next recommendation request or session start can try a failed source again.

Feed-provided bodies, summaries, and links retain their actual content type. Linked article pages are not fetched automatically, and preparation does not generate model summaries. Articles stay in the local library; preparation does not automatically delete saved articles.

## Read your library

Ask Pi to search saved items or open a saved article:

- “Search my library for urban design.”
- “Open that saved article.”

Search results show short local previews. Opening an article in interactive Pi displays the saved text in a scrollable local reader. Summary-only entries show their summary and original link. Saved text stays out of model-visible tool results; the reader is for you. Without an interactive UI, Pi returns the saved reference instead of opening the reader.

Library search and reading work offline. To delete an item, ask `Delete saved item ITEM_ID`.

External source-module loading is no longer supported. Articles saved by earlier integrations remain available in the library.

## Direction

Recommendations currently use title/summary matching and source diversity. Dwell scheduling and learning from reading feedback are future work.
