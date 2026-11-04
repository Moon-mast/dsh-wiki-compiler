将 Markdown 写入 `wiki/` 或 `derived/` 下的指定路径。

**参数**：
- `markdown`：完整正文
- `path`：相对 vault 根的路径，必须以 `wiki/` 或 `derived/` 开头

**行为约束**：
- 写入前旧版自动备份到 `_meta/versions/`。
- **禁止写入 `raw/`**，路径白名单会在执行时拒绝越界请求。
- 不删除文件，只新建或覆盖。

**典型调用时机**：四级分流判断完成后，逐页写入；以及 Query 结果归档到 `derived/` 时。