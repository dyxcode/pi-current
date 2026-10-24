# pi-current

[English](../../README.md) | 简体中文

**搜索网页，追随兴趣。**

pi-current 是一个 [Pi](https://github.com/earendil-works/pi) 扩展，通过对话提供网页搜索、来源登录、文章获取和本地内容库浏览。

## 搜索与阅读

直接让 Pi 搜索话题、读取 URL，或打开搜索结果：

- “搜索最近关于 local-first software 的文章。”
- “读取第二条结果，解释它的主要论点。”

搜索结果附有来源链接。公开页面读取支持 HTML、纯文本和 Markdown。

## 连接来源

Source Plugin 将 pi-current 连接到需要登录或使用专门方式获取文章的网站。每个插件提供对应来源支持的操作。

1. 在 Pi 中打开 `/sources`，选择 **Add source**。
2. 输入本地 `.mjs`、`.js` 或 `.ts` 插件文件的绝对路径。
3. 如果来源提供相应选项，使用 **Log in** 或 **Reconnect** 完成登录，通过 **Check connection** 检查访问状态。
4. 在聊天中请求单篇文章或一批内容。

请求中使用已注册的来源 ID 或显示名称。以注册 ID 为 `sample` 的来源为例：

| 请求 | 功能 |
| --- | --- |
| `Log in to sample` | 打开来源的登录流程 |
| `Check sample connection` | 检查当前连接 |
| `Read https://example.com/article from sample` | 获取单篇文章 |
| `Collect 3 items from sample` | 获取并保存一批内容 |

`/sources` 还可以启用、禁用、重新连接或移除来源。

注册 [`examples/source-plugin.mjs`](../../examples/source-plugin.mjs)，可以用示例文章体验来源管理和内容库。

## 浏览已保存内容

采集的文章保存在本地内容库中。让 Pi 展示已保存条目、搜索内容库，或打开一篇已保存文章即可。来源文章显示在 Pi 本地卡片中。

内容库搜索也能找到已禁用或移除来源的历史文章。删除条目时，使用 `Delete saved item ITEM_ID`。

## 后续方向

长远方向是通过本地内容库以及兴趣与阅读信号，连接实时搜索和内容推荐。基于模型的私有文章推荐列入后续计划。
