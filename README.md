# pi-current

English | [简体中文](docs/i18n/README.zh-CN.md)

**Search the web. Follow your interests.**

pi-current is a [Pi](https://github.com/earendil-works/pi) extension for searching the web, logging in to sources, retrieving articles, and browsing a local content library through conversation.

## Search and read

Ask Pi to search a topic, read a URL, or open a search result:

- “Search for recent articles about local-first software.”
- “Read the second result and explain its main argument.”

Search results include source links. Public page reading supports HTML, plain text, and Markdown.

## Connect a source

Source Plugins connect pi-current to sites that need login or their own article retrieval method. Each plugin provides the operations its source supports.

1. Open `/sources` in Pi and select **Add source**.
2. Enter the absolute path to your local `.mjs`, `.js`, or `.ts` plugin.
3. Select the source and use **Set up access…** to configure access. If it offers several methods, choose one.
4. Use **View status** to see all cached connection states and their last check times. If the plugin supports checking access, request a connection check in chat.
5. Request an article or a batch in chat.

Use the registered source ID or display name in your request. For a source registered as `sample`:

| Request | Function |
| --- | --- |
| `Log in to sample` | Open the source's login flow |
| `Check sample connection` | Check its current connection |
| `Read https://example.com/article from sample` | Retrieve one article |
| `Collect 3 items from sample` | Retrieve and save a batch |

`/sources` also lets you enable, disable, or remove a source.

To try source management and the library with sample articles, register [`examples/source-plugin.mjs`](examples/source-plugin.mjs).

## Browse saved content

Collected articles are saved in a local library. Requested saves retain the retrieved article body. Ask Pi to show saved items, search the library, or open a saved article. Source cards show the title and up to 200 characters of a supplied summary or body preview.

Library search can find saved articles from disabled or removed sources. To delete an item, use `Delete saved item ITEM_ID`.

## Direction

The long-term direction is to connect live search and recommendations through the local library and interest and reading signals. Model-based recommendations for private articles are planned.
