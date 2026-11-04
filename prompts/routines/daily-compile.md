# 每日知识库编译任务

1. 调用 `fetch_ai_news`，`hoursBack=24`。如果返回空数组，记录日志并结束，**不要编造内容**。
2. 调用 `read_wiki_index`，拿到 `index.md` 和未编译条目列表。
3. 对每条未编译 raw，按编译总则的「四级分流」处理：
   - 先 `search_wiki` 检索相关页面；
   - 读取最相关的 2–5 个现有页面（`read_wiki_file`）；
   - 按分流结果写入 `wiki/`（`write_wiki_file`）；
   - 更新该页的一句话摘要和 `index.md` 对应行。
4. 生成当日视图 `timelines/daily-YYYY-MM-DD.md`：从本次编译的条目中按重要性挑选，每条链回 `sources/` 和相关 `concepts/`。
5. 更新 `manifest.json`，标记已编译条目及其去向。
6. 如果发现矛盾，写入 `_meta/lint-report.md`，不修改旧内容。

**结束条件**：所有未编译条目处理完毕，或达到 15 条上限。输出一条简短日志：处理条数、新建页数、更新页数、矛盾条数。