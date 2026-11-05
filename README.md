# dsh-wiki-compiler

一个 DeepSeek Harness（DSH）bundle 插件：把 `prompts/` 里的知识库编译规则，落成**可安装、可运行**的一组模型工具 + 提示词段落 + 现成的 agent preset。

它面向 Obsidian 式知识库：`raw/` 存放原始材料（只读），`wiki/` 是编译产物（concepts / entities / timelines / sources），`derived/` 存放问答产物，`_meta/` 存放清单、体检报告与版本备份。

- **零运行时依赖**：只用 Node 内置模块和 DSH 已经提供的服务（`tools`、`workingDirectory`、`systemPrompt`）。
- **Host-only**：不注册客户端 UI，也不需要构建步骤；`index.js` 即插件本体。
- **规则与工具同源**：`prompts/**` 既是写作规范，也是插件运行时读取的资产（`kb_routine` 按需加载，不常驻上下文）。

## 目录

```
.
├── index.js               # 插件本体：6 个工具 + 编译规则提示词段落
├── cordis.patch.yml       # bundle patch：全局工具行 + “知识库编译” agent preset
├── prompts/
│   ├── sections/compile-rules.md          # 编译总则（三级铁律 + 四级分流 + 格式规范）
│   ├── tools/*.md                         # 5 个工具的规格说明
│   └── routines/*.md                      # daily-compile / weekly-lint / query 三套流程
├── examples/vault/        # 可直接打开的示例知识库（含 raw/ 与 wiki/ 各一篇）
├── test/smoke.mjs         # 离线冒烟测试：假 ctx + 临时 vault + 输出 schema 校验
└── package.json
```

## 安装

在 DSH 中通过插件管理器安装本包（包目录即本仓库根目录）：

```text
plugin_manager({ action: "install_bundle", target: "<本仓库绝对路径>" })
```

安装后：

- **工具全局可见**：所有 agent 都能看到 `read_wiki_index`、`search_wiki`、`read_wiki_file`、`write_wiki_file`、`fetch_ai_news`、`kb_routine`。
- **新增 agent preset「知识库编译」**：新建 agent 时选择它，即可获得编译总则段落 + 文件/搜索/网页/待办工具；该 preset 内的工具是作用域内注册，会遮蔽同名的全局工具。

修改 `index.js` 后需要重新加载模块：在插件列表里把本插件（或整个 bundle）停用再启用一次即可；不行再重启 DSH。

修改 `cordis.patch.yml`（例如换成自己的 `vaultRoot`、增删 preset 内的工具）后，同样把整个 bundle 停用再启用一次——DSH 会在启用时重新读取本包的补丁层；只重启本插件行不会重读配置。

> 注意：本 preset 复用官方插件行时，必须满足它们的必填配置。已知必填项：
> `@deepseek-ai/dsh-tool-fs-search` 的 `sampleOverCapGlobResults`、`@deepseek-ai/dsh-tool-todo` 的 `allowParallelInProgress`。
> 缺任何一项，选择「知识库编译」时会报 `缺少必填配置` 并加载失败。

## 工具

| 工具 | 作用 |
| --- | --- |
| `read_wiki_index` | 返回 `{index, uncompiled}`：`wiki/index.md` 全文 + `_meta/manifest.json` 中尚未编译的 raw 条目。每次编译第一步调用。 |
| `search_wiki` | 关键词 / 正则搜索 `wiki/`，可按 `scope` 限定 `concepts`、`entities`、`timelines`、`sources`，返回 `[{path, snippet}]`。写页面前必须调用。 |
| `read_wiki_file` | 读取单页全文（含 frontmatter）。搜索后读 2–5 篇相关页面。 |
| `write_wiki_file` | 写 `wiki/`、`derived/`、`_meta/`；写入前把旧版本备份到 `_meta/versions/`；**拒绝写 `raw/`**，只创建/覆盖，不删除。 |
| `fetch_ai_news` | 抓取近 `hoursBack` 小时的 AI 新闻，返回 `[{source, title, link, contentSnippet, pubDate}]`；只抓取不总结；单源失败写入 `failedSources` 而不阻塞。 |
| `kb_routine` | 按需加载 `daily-compile`、`weekly-lint`、`query` 或 `compile-rules` 的 Markdown 正文。 |

工具路径均相对 **vault 根目录**：默认就是当前会话的工作目录，因此同一个安装可以在任意 vault 里使用。

## 配置

`cordis.patch.yml` 里两行配置都可以改：

```yaml
- insert:
    - id: dsh-wiki-compiler
      name: 'dsh-wiki-compiler'
      config:
        vaultRoot: ''        # 留空 = 使用会话工作目录；也可写绝对路径或相对会话目录的路径
        registerPrompt: false # true = 把编译总则注册为全局提示词段落
        feeds: []            # 覆盖默认 RSS 源：[{name, url}]
        timeoutMs: 15000     # 单个源抓取超时
```

要恢复默认 RSS 源，把 `feeds` 删掉即可（`[]` 视为未配置）。默认源：TechCrunch AI、VentureBeat AI、MIT Technology Review AI、The Verge AI、量子位、机器之心。

## 知识库约定

```
vault/
├── raw/                     # 原始材料，插件只读
│   └── 2026-03-01/rag.md
├── wiki/
│   ├── index.md             # 索引：每页首句定义同步到这里
│   ├── concepts/            # 概念页（首行 = 一句话定义）
│   ├── entities/            # 实体页（公司 / 人物 / 产品）
│   ├── timelines/           # 时间线（daily-YYYY-MM-DD.md）
│   └── sources/             # 来源页：列出“被以下页面引用”
├── derived/                 # 问答产物：YYYY-MM-DD-<slug>.md
└── _meta/
    ├── manifest.json        # 编译清单
    ├── lint-report.md       # 矛盾 / 体检 / 待补充主题
    └── versions/            # write_wiki_file 自动备份
```

`_meta/manifest.json` 的约定格式：

```json
{
  "version": 1,
  "entries": [
    {
      "path": "raw/2026-03-01/rag.md",
      "date": "2026-03-01",
      "compiled": false,
      "destinations": []
    },
    {
      "path": "raw/2026-03-01/agents.md",
      "date": "2026-03-01",
      "compiled": true,
      "destinations": ["wiki/concepts/agents.md"]
    }
  ]
}
```

`read_wiki_index` 只返回 `compiled !== true` 的条目；manifest 不存在时会退回扫描 `raw/` 下的 Markdown（日期取文件名中的 `YYYY-MM-DD`），方便从零开始。例行流程负责把 `compiled` 与 `destinations` 回写。

## 使用

1. 新建 agent，preset 选「知识库编译」。
2. 让它按流程走：
   - 每日：`kb_routine({name: "daily-compile"})`，然后照步骤执行（抓取 → 读索引 → 逐篇四级分流 → 时间线 → 回写 manifest → 矛盾留痕）。
   - 每周：`kb_routine({name: "weekly-lint"})`，只输出建议到 `_meta/lint-report.md`，不改旧页面。
   - 问答：`kb_routine({name: "query"})`，答案写 `derived/`，并回链相关概念页。

也可以用 DSH 的定时任务（`@deepseek-ai/dsh-tool-schedule`，需自行加到 preset）在每个早晨触发 `daily-compile`。

## 开发

```bash
node test/smoke.mjs     # 离线冒烟：无需网络、无需 DSH
node --check index.js
```

冒烟测试覆盖：6 个工具注册、提示词段落、索引/manifest 解析、搜索（含 scope）、读写与备份、`raw/` 与路径穿越拒绝、三套例行流程加载、单源失败降级，并把每个返回值按工具自己的 output schema 校验一遍（与 DSH registry 的校验口径一致）。

## 许可

MIT，见 [LICENSE](./LICENSE)。
