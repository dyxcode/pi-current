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

Give Pi an RSS 2.0 or Atom 1.0 feed URL:

- “Import 5 items from https://example.org/feed.xml.”

The built-in feed module fetches the feed and saves its entries to your library. It preserves feed-provided article text, summaries, and links. Summary-only entries remain marked as summaries; linked articles are not fetched automatically. Reimporting the same feed reuses existing items and retains changed versions.

The import result reports saved items and entry issues, including any skipped content. Feed content comes from its publisher; importing it does not establish that it matches the full article on the website.

## Read your library

Ask Pi to search saved items or open a saved article:

- “Search my library for urban design.”
- “Open that saved article.”

Search results show short local previews. Opening an article in interactive Pi displays the saved text in a scrollable local reader. Summary-only entries show their summary and original link. Saved text stays out of model-visible tool results; the reader is for you. Without an interactive UI, Pi returns the saved reference instead of opening the reader.

Library search and reading work offline. To delete an item, ask `Delete saved item ITEM_ID`. Removing a source module preserves saved articles.

## Add a source module

The RSS/Atom module is built in. Additional modules provide the same fetch-and-import workflow:

1. Open `/sources` in Pi and select **Add module**.
2. Enter the absolute path to a trusted `.mjs`, `.js`, or `.ts` module.
3. Ask Pi to import a URL with that module's ID.

For a network-free example, register [`examples/source-plugin.mjs`](examples/source-plugin.mjs), then ask: “Import 2 items from https://example.org/feed.xml using sample.”

`/sources` also lists modules and removes external registrations. Earlier plugins using login/check, `create`, or named operations need updating to the fetch interface before registration.

## Direction

Persistent subscriptions, scheduled refresh, and recommendations are planned. The current import workflow runs when requested.
