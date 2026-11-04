在 `wiki/` 中做关键词和正则检索，返回命中文件路径与上下文片段。

**参数**：
- `query`：关键词或正则表达式
- `scope`：可选，`concepts` / `entities` / `timelines` / `sources` / 全部

**返回**：`Array<{ path: string, snippet: string }>`

**典型调用时机**：写入任何 wiki 页面前，用它确认是否已有相关页面，避免重复建页。编译总则的「先读后写」规则依赖此工具。