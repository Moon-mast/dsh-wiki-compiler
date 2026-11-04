# 示例知识库

把 `examples/vault` 当作 DSH 会话的工作目录（或在 bundle 配置里把 `vaultRoot` 指向它），
就可以在不抓取真实新闻的前提下试跑整套流程。

```
vault/
├── raw/2026-03-01/rag.md          # 待编译：manifest 里 compiled=false
├── wiki/index.md                  # 索引
├── wiki/concepts/rag.md           # 已编译的概念页（首行即一句话定义）
├── wiki/sources/2026-03-01-news.md
└── _meta/manifest.json
```
