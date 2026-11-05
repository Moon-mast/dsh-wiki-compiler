# 更新日志

## 0.2.0

- 新增浏览器半 `client/console.js`：输入框下方可折叠控制台，「立即编译 / 运行 Lint / 停止」三个按钮。
- 触发链路：`sessions.retain(sessionId)` → `session.prompt([{type:"text"}], "queue")`，指令要求 Agent 先加载对应
  Routine（`kb_routine`）再执行；不使用自建事件类型，也不在前端起本地端口。
- 日志链路：订阅同一会话的 `binding.eventSource`（即 `session/event`），把 `turn/start`、`tool/call`、
  `tool/result`、`turn/end`、`agent/error` 投影为日志行，最多 400 行；日志为只读旁路，不影响 Agent 上下文。
- 推送前脱敏（`api_key` / `token` / `password` / `secret` / `Authorization: Bearer`）并截断到 200 字。
- 面板关闭或插件卸载时释放会话引用、取消订阅，不重复注册监听。
- 新增 `test/console.mjs`：脱敏、截断、参数摘要、事件投影、例行指令、slot 注册的离线校验。

## 0.1.1

- 修复：预设 `wiki-compiler` 加载失败。`@deepseek-ai/dsh-tool-fs-search` 的 Config 中
  `sampleOverCapGlobResults` 是必填项，预设行现在显式传入 `false`（与官方 `standard` 预设一致）。
- 同时为 `@deepseek-ai/dsh-tool-todo` 的必填 `allowParallelInProgress` 补上注释，避免同类问题。

## 0.1.0

- 首个版本：5 个知识库工具（`read_wiki_index`、`search_wiki`、`read_wiki_file`、
  `write_wiki_file`、`fetch_ai_news`）、`kb_routine` 按需加载例程、`wiki-compiler` 提示词段落、
  「知识库编译」agent 预设、示例 vault 与离线冒烟测试。
