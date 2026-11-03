# pi-current

English | [简体中文](docs/i18n/README.zh-CN.md)

**Search the web. Follow your interests.**

pi-current is a [Pi](https://github.com/earendil-works/pi) extension for public web search, RSS/Atom imports, and reading a local article library through conversation.

## Search and read

Ask Pi to search a topic, read a URL, or open a search result:

- “Search for recent articles about local-first software.”
- “Read the second result and explain its main argument.”

Search results include source links. Public page reading supports HTML, plain text, and Markdown.

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

The next direction is a reading workflow that selects sources and ranks articles for your current interests. A default source pool and retrieval/ranking are planned; the current tools provide web access, feed imports, and local reading.
