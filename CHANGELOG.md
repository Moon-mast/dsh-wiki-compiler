# 更新日志

## 0.1.1

- 修复：预设 `wiki-compiler` 加载失败。`@deepseek-ai/dsh-tool-fs-search` 的 Config 中
  `sampleOverCapGlobResults` 是必填项，预设行现在显式传入 `false`（与官方 `standard` 预设一致）。
- 同时为 `@deepseek-ai/dsh-tool-todo` 的必填 `allowParallelInProgress` 补上注释，避免同类问题。

## 0.1.0

- 首个版本：5 个知识库工具（`read_wiki_index`、`search_wiki`、`read_wiki_file`、
  `write_wiki_file`、`fetch_ai_news`）、`kb_routine` 按需加载例程、`wiki-compiler` 提示词段落、
  「知识库编译」agent 预设、示例 vault 与离线冒烟测试。
