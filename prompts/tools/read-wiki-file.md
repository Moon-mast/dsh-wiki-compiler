读取单个 wiki 页面的全文。

**参数**：`path`，相对 vault 根的路径，例如 `wiki/concepts/rag.md`

**返回**：文件全文，含 frontmatter。

**典型调用时机**：`search_wiki` 命中候选页后，读取最相关的 2–5 页全文，再决定如何合并或追加。