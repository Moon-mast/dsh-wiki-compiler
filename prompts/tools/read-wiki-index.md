返回 `wiki/index.md` 全文和 `_meta/manifest.json` 中尚未编译的 raw 条目列表。

**返回**：`{ index: string, uncompiled: Array<{ path: string, date: string }> }`

**典型调用时机**：每次编译任务开始时先调用此工具，获得全局视图后再决定读哪些页面。不要跳过这一步直接 `search_wiki`，否则容易遗漏已有页面。