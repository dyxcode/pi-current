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

- “Find five articles across technology, humanities, and everyday life.”
- “Find articles about urban life and loneliness.”

Pi looks through the current entries from your enabled feeds, selects articles, and saves the selection to your library. Mixed reading alternates between sources. Topic requests match words or phrases in titles and summaries, with title matches first. This searches current feed entries, not each publisher's full archive.

The local reading cards show results in order, with the source, publication date when available, and matched terms for topic requests. Ask “Open the second article” to read its saved text. Entries with only a summary show that summary and the original link. A source failure is reported alongside any saved results.

## Choose your sources

Open `/source` in Pi to add a feed, enable or disable a source, or remove it from the list. Changes are saved automatically. Adding a source asks for its RSS/Atom URL and display name; content is fetched when you request reading discovery.

The default sources are [MIT Research](https://news.mit.edu/rss), [JSTOR Daily](https://daily.jstor.org/), and [Psyche](https://psyche.co/). They cover research and technology, humanities, and everyday psychology. Removing a source keeps its saved articles in your library.

## Import a feed

Pi can import an RSS 2.0 or Atom 1.0 feed you provide or select one for your current reading task:

- “Import 5 items from https://example.org/feed.xml.”

Feed import is built in. It fetches the feed and saves its entries to your library. It preserves feed-provided article text, summaries, and links. Summary-only entries remain marked as summaries; linked articles are not fetched automatically. Reimporting the same feed reuses existing items and retains changed versions.

The import result reports saved items and specific entry issues, including any skipped content. Feed content comes from its publisher; importing it does not establish that it matches the full article on the website.

## Read your library

Ask Pi to search saved items or open a saved article:

- “Search my library for urban design.”
- “Open that saved article.”

Search results show short local previews. Opening an article in interactive Pi displays the saved text in a scrollable local reader. Summary-only entries show their summary and original link. Saved text stays out of model-visible tool results; the reader is for you. Without an interactive UI, Pi returns the saved reference instead of opening the reader.

Library search and reading work offline. To delete an item, ask `Delete saved item ITEM_ID`.

External source-module loading is no longer supported. Articles saved by earlier integrations remain available in the library.

## Direction

Reading discovery currently uses title/summary matching and source diversity. Scheduled collection and learning from reading feedback are future work.
