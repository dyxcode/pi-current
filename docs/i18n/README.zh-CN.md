# pi-current

[English](../../README.md) | 简体中文

**搜索网络，关注你的兴趣。**

pi-current 是一个 [Pi](https://github.com/earendil-works/pi) 扩展，通过对话搜索公开网页、导入 RSS/Atom，并阅读本地文章库。

## 搜索与阅读

让 Pi 搜索主题、读取 URL，或打开搜索结果：

- “搜索最近关于 local-first software 的文章。”
- “阅读第二条结果，解释它的主要观点。”

搜索结果附带来源链接。公开网页阅读支持 HTML、纯文本和 Markdown。

## 导入订阅源

向 Pi 提供 RSS 2.0 或 Atom 1.0 feed URL：

- “从 https://example.org/feed.xml 导入 5 条内容。”

内置 feed module 获取订阅源并将条目保存到本地 library，保留来源提供的文章文本、摘要和链接。只有摘要的条目仍标为摘要，不会自动访问链接补全正文。重复导入同一 feed 会复用已有条目，并保留内容变化的版本。

导入结果会说明保存数量和条目问题，包括跳过的内容。Feed 内容由发布者提供，导入并不代表它与网站上的完整文章一致。

## 阅读本地文章库

让 Pi 搜索已保存内容或打开文章：

- “在我的 library 中搜索城市设计。”
- “打开那篇已保存的文章。”

搜索结果显示简短的本地预览。在交互式 Pi 中打开文章后，可以在本地阅读器中滚动阅读保存的文本。只有摘要的条目显示摘要和原文链接。正文不进入模型可见的工具结果，阅读器用于你直接阅读。没有交互式 UI 时，Pi 返回已保存条目的引用，不会打开阅读器。

Library 搜索和阅读支持离线使用。删除条目时，明确指定 `Delete saved item ITEM_ID`。移除 source module 会保留已保存文章。

## 添加 source module

RSS/Atom module 已内置，其他 modules 使用相同的获取与导入流程：

1. 在 Pi 中打开 `/sources`，选择 **Add module**。
2. 输入可信 `.mjs`、`.js` 或 `.ts` module 的绝对路径。
3. 请求导入 URL，并指定 module ID。

如需使用无需联网的示例，注册 [`examples/source-plugin.mjs`](../../examples/source-plugin.mjs)，然后请求：“使用 sample，从 https://example.org/feed.xml 导入 2 条内容。”

`/sources` 也可列出 modules、移除外部注册。原来使用 login/check、`create` 或 named operations 的 plugins，需要更新为 fetch 接口后再注册。

## 后续方向

持久化 subscriptions、定时刷新和推荐属于后续计划。目前的导入流程在明确请求时运行。
