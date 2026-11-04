/**
 * dsh-wiki-compiler
 *
 * A DeepSeek Harness host bundle that turns `raw/` news into a linked Obsidian-style
 * `wiki/`. It registers five model-facing tools described in `prompts/tools/*.md`,
 * an on-demand routine library, and (optionally) the compile rules as a prompt section.
 *
 * Zero runtime dependencies: it only uses Node's built-in modules and the services
 * DSH already provides (`tools`, `workingDirectory`, `systemPrompt`).
 */

import { readFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-wiki-compiler'

/** `tools` is mandatory; `workingDirectory` and `systemPrompt` are read through `ctx.get`. */
export const inject = ['tools']

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const PROMPTS_DIR = join(PACKAGE_DIR, 'prompts')

/** Directories `write_wiki_file` may touch. `raw/` is deliberately absent: it is read-only. */
const WRITE_PREFIXES = ['wiki/', 'derived/', '_meta/']
/** Directories `search_wiki` searches, keyed by the spec's `scope` values. */
const SEARCH_SCOPES = ['concepts', 'entities', 'timelines', 'sources']

const DEFAULT_FEEDS = [
  { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
  { name: 'MIT Technology Review AI', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed' },
  { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { name: '量子位', url: 'https://www.qbitai.com/feed' },
  { name: '机器之心', url: 'https://www.jiqizhixin.com/rss' },
]

const ROUTINES = ['daily-compile', 'weekly-lint', 'query']

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function readPrompt(relativePath) {
  return readFileSync(join(PROMPTS_DIR, relativePath), 'utf8')
}

/** Model-facing text projection for every tool result. */
const asJson = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

const objectSchema = (properties) => ({
  type: 'object',
  additionalProperties: false,
  properties,
})

async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function readTextIfExists(target) {
  try {
    return await readFile(target, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return undefined
    throw error
  }
}

async function readJsonIfExists(target) {
  const text = await readTextIfExists(target)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${target} is not valid JSON: ${error.message}`)
  }
}

/**
 * Normalize a vault-relative path and reject anything that could escape the vault.
 * Accepts `wiki/concepts/rag.md`; rejects absolute paths, drive letters, `..`.
 */
function normalizeRelPath(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('path must be a non-empty string relative to the vault root')
  }
  let path = input.trim().replace(/\\/g, '/')
  if (path.startsWith('/')) throw new Error(`path must be relative to the vault root: ${input}`)
  if (/^[a-zA-Z]:/.test(path)) throw new Error(`path must not contain a drive letter: ${input}`)
  const parts = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') throw new Error(`path must not contain '..': ${input}`)
    parts.push(part)
  }
  if (parts.length === 0) throw new Error('path must point at a file inside the vault')
  return parts.join('/')
}

/** Resolve a vault-relative path to an absolute one, asserting it stays under `root`. */
function resolveInVault(root, relativePath) {
  const absolute = resolve(root, relativePath)
  const guard = root.endsWith(sep) ? root : root + sep
  if (absolute !== root && !absolute.startsWith(guard)) {
    throw new Error(`path escapes the vault: ${relativePath}`)
  }
  return absolute
}

/** All Markdown files below `dir`, as vault-relative paths using `/` separators. */
async function listMarkdown(root, dir) {
  const out = []
  const walk = async (absolute, prefix) => {
    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return
      throw error
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        await walk(join(absolute, entry.name), relative)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(relative)
      }
    }
  }
  await walk(join(root, dir), dir.split('\\').join('/'))
  return out.sort()
}

function isoDayFromName(path) {
  const match = path.match(/(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : undefined
}

/**
 * The vault root for one tool call.
 *
 * `config.vaultRoot` wins (relative paths resolve against the session directory);
 * otherwise the session working directory is the vault, and headless callers fall
 * back to the deployment default directory.
 */
async function resolveVaultRoot(ctx, config, exec) {
  const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : ctx.workingDirectory
  let base
  if (workingDirectory) {
    if (exec?.agent) {
      try {
        base = await workingDirectory.ensure(exec.agent, exec.signal)
      } catch {
        base = undefined
      }
    }
    base ??= workingDirectory.defaultDirectory
  }
  base ??= process.cwd()
  const configured = typeof config?.vaultRoot === 'string' ? config.vaultRoot.trim() : ''
  return configured ? resolve(base, configured) : resolve(base)
}

// ---------------------------------------------------------------------------
// RSS fetching
// ---------------------------------------------------------------------------

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

function cleanText(text) {
  const unwrapped = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  return decodeEntities(unwrapped.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function pickTag(block, tags) {
  for (const tag of tags) {
    const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'))
    if (match) return cleanText(match[1])
  }
  return undefined
}

function pickAtomLink(block) {
  const withRel = block.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i)
  if (withRel) return withRel[1]
  const withHref = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i)
  if (withHref) return withHref[1]
  const inline = block.match(/<link>([\s\S]*?)<\/link>/i)
  return inline ? cleanText(inline[1]) : undefined
}

/** Extract `{title, link, contentSnippet, pubDate}` records from an RSS or Atom document. */
function parseFeed(xml, source) {
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0])
  const items = []
  for (const block of blocks) {
    const title = pickTag(block, ['title'])
    const link = pickAtomLink(block)
    const snippet = pickTag(block, ['description', 'summary', 'content:encoded', 'content'])
    const pubDate = pickTag(block, ['pubDate', 'published', 'updated', 'dc:date'])
    if (!title || !link) continue
    items.push({
      source,
      title,
      link,
      contentSnippet: (snippet ?? '').slice(0, 800),
      pubDate: pubDate ?? '',
    })
  }
  return items
}

async function fetchFeed(feed, options) {
  const response = await fetch(feed.url, {
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: { 'user-agent': 'dsh-wiki-compiler/0.1 (+https://github.com/)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    redirect: 'follow',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const xml = await response.text()
  return parseFeed(xml, feed.name)
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

function createTools(ctx, config) {
  const toolConfig = config ?? {}

  const fetchAiNews = {
    name: 'fetch_ai_news',
    description:
      'Fetch recent AI news from curated mainstream media RSS feeds. Returns items published within the last `hoursBack` hours as `{source, title, link, contentSnippet, pubDate}`, plus per-feed diagnostics. Fetch only — it never summarizes or writes anything. A failing feed is reported in `failedSources` and never fails the call. Call it as the first step of the daily compile routine.',
    parameters: objectSchema({
      hoursBack: {
        type: 'number',
        description: 'Only return items published within this many hours. Defaults to 24.',
      },
      maxPerSource: {
        type: 'number',
        description: 'Maximum items kept per feed after time filtering. Defaults to 20.',
      },
      feeds: {
        type: 'array',
        description: 'Override the configured feeds. Defaults to the bundle configuration.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Display name of the media outlet.' },
            url: { type: 'string', description: 'RSS or Atom feed URL.' },
          },
          required: ['name', 'url'],
        },
      },
    }),
    output: {
      schema: objectSchema({
        fetchedAt: { type: 'string', description: 'ISO timestamp of the fetch.' },
        hoursBack: { type: 'number', description: 'The window that was requested.' },
        checkedSources: { type: 'number', description: 'Number of feeds attempted.' },
        items: {
          type: 'array',
          description: 'News items inside the window, newest first.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              source: { type: 'string' },
              title: { type: 'string' },
              link: { type: 'string' },
              contentSnippet: { type: 'string' },
              pubDate: { type: 'string' },
            },
            required: ['source', 'title', 'link', 'contentSnippet', 'pubDate'],
          },
        },
        failedSources: {
          type: 'array',
          description: 'Feeds that could not be read; their text is the reason.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              error: { type: 'string' },
            },
            required: ['name', 'error'],
          },
        },
      }),
      render: (args, value) => asJson(value),
    },
    async execute(args) {
      const input = args ?? {}
      const hoursBack = Number.isFinite(input.hoursBack) ? input.hoursBack : 24
      const maxPerSource = Number.isFinite(input.maxPerSource) ? input.maxPerSource : 20
      const feeds = Array.isArray(input.feeds) && input.feeds.length > 0
        ? input.feeds
        : Array.isArray(toolConfig.feeds) && toolConfig.feeds.length > 0
          ? toolConfig.feeds
          : DEFAULT_FEEDS
      const options = { timeoutMs: Number.isFinite(toolConfig.timeoutMs) ? toolConfig.timeoutMs : 15000 }
      const cutoff = Date.now() - hoursBack * 3600_000

      const settled = await Promise.allSettled(feeds.map((feed) => fetchFeed(feed, options)))
      const items = []
      const failedSources = []
      settled.forEach((result, index) => {
        const feed = feeds[index]
        if (result.status === 'rejected') {
          failedSources.push({ name: feed.name, error: String(result.reason?.message ?? result.reason) })
          return
        }
        const fresh = []
        for (const item of result.value) {
          const published = Date.parse(item.pubDate)
          if (Number.isFinite(published) && published < cutoff) continue
          fresh.push({ item, published: Number.isFinite(published) ? published : Date.now() })
        }
        fresh.sort((a, b) => b.published - a.published)
        for (const { item } of fresh.slice(0, maxPerSource)) items.push(item)
      })
      items.sort((a, b) => {
        const left = Date.parse(a.pubDate)
        const right = Date.parse(b.pubDate)
        return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0)
      })

      return {
        fetchedAt: new Date().toISOString(),
        hoursBack,
        checkedSources: feeds.length,
        items,
        failedSources,
      }
    },
  }

  const readWikiIndex = {
    name: 'read_wiki_index',
    description:
      'Read the wiki index and the list of raw entries that still need compiling. Returns `{index, uncompiled}` where `index` is the full text of `wiki/index.md` and `uncompiled` comes from `_meta/manifest.json` (falling back to a scan of `raw/` when the manifest does not exist yet). Call it first in every compile run, before any write.',
    parameters: objectSchema({}),
    output: {
      schema: objectSchema({
        index: { type: 'string', description: 'Full text of wiki/index.md; empty when the index does not exist yet.' },
        uncompiled: {
          type: 'array',
          description: 'Raw entries not yet compiled, oldest first.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: 'Vault-relative path of the raw note.' },
              date: { type: 'string', description: 'Publication date in YYYY-MM-DD form; empty when unknown.' },
            },
            required: ['path', 'date'],
          },
        },
      }),
      render: (args, value) => asJson(value),
    },
    async execute(args, exec) {
      const root = await resolveVaultRoot(ctx, toolConfig, exec)
      const index = (await readTextIfExists(join(root, 'wiki', 'index.md'))) ?? ''
      const manifest = await readJsonIfExists(join(root, '_meta', 'manifest.json'))

      const entries = []
      if (manifest && Array.isArray(manifest.entries)) {
        for (const entry of manifest.entries) {
          if (!entry || entry.compiled === true) continue
          if (typeof entry.path !== 'string') continue
          entries.push({ path: entry.path, date: typeof entry.date === 'string' ? entry.date : '' })
        }
      } else if (!manifest) {
        const rawPaths = await listMarkdown(root, 'raw')
        for (const path of rawPaths) {
          entries.push({ path, date: isoDayFromName(path) ?? '' })
        }
      }
      entries.sort((a, b) => a.date.localeCompare(b.date) || a.path.localeCompare(b.path))
      return { index, uncompiled: entries }
    },
  }

  const searchWiki = {
    name: 'search_wiki',
    description:
      'Search the wiki by keyword or regular expression before writing any page. `query` is matched line by line (case-insensitive regex; an invalid regex falls back to a literal search). `scope` limits the search to one wiki subdirectory. Returns an array of `{path, snippet}`, where `snippet` is the matching line trimmed to 300 characters.',
    parameters: objectSchema({
      query: {
        type: 'string',
        description: 'Keyword or regular expression to look for.',
      },
      scope: {
        type: 'string',
        description: 'Limit the search to one wiki subdirectory.',
        enum: ['concepts', 'entities', 'timelines', 'sources', 'all'],
      },
    }),
    output: {
      schema: {
        type: 'array',
        description: 'Matches in vault-relative path order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: 'Vault-relative path of the matching page.' },
            snippet: { type: 'string', description: 'The matching line, trimmed to 300 characters.' },
          },
          required: ['path', 'snippet'],
        },
      },
      render: (args, value) => asJson(value),
    },
    async execute(args, exec) {
      const input = args ?? {}
      if (typeof input.query !== 'string' || input.query.trim() === '') {
        throw new Error('query must be a non-empty string')
      }
      const root = await resolveVaultRoot(ctx, toolConfig, exec)
      const scope = input.scope ?? 'all'
      const matcher = buildMatcher(input.query)
      const dirs = scope === 'all' ? SEARCH_SCOPES : [scope]

      const results = []
      for (const dir of dirs) {
        for (const relative of await listMarkdown(root, join('wiki', dir))) {
          const absolute = join(root, relative)
          const content = await readTextIfExists(absolute)
          if (content === undefined) continue
          for (const line of content.split(/\r?\n/)) {
            matcher.lastIndex = 0
            if (!matcher.test(line)) continue
            results.push({ path: relative, snippet: line.trim().slice(0, 300) })
            break
          }
          if (results.length >= 60) return results
        }
      }
      return results
    },
  }

  const readWikiFile = {
    name: 'read_wiki_file',
    description:
      'Read one wiki page in full, including its frontmatter. `path` is relative to the vault root, for example `wiki/concepts/rag.md`. After `search_wiki`, read the two to five most relevant pages before writing so replacements stay consistent.',
    parameters: objectSchema({
      path: {
        type: 'string',
        description: 'Vault-relative path of the page, for example wiki/concepts/rag.md.',
      },
    }),
    output: {
      schema: objectSchema({
        path: { type: 'string', description: 'The requested vault-relative path.' },
        content: { type: 'string', description: 'Full page text, including frontmatter.' },
        frontmatter: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description: 'The frontmatter block without fences, or null when the page has none.',
        },
      }),
      render: (args, value) => asJson(value),
    },
    async execute(args, exec) {
      const input = args ?? {}
      const relative = normalizeRelPath(input.path)
      const root = await resolveVaultRoot(ctx, toolConfig, exec)
      const absolute = resolveInVault(root, relative)
      const content = await readTextIfExists(absolute)
      if (content === undefined) throw new Error(`page not found: ${relative}`)
      return { path: relative, content, frontmatter: extractFrontmatter(content) }
    },
  }

  const writeWikiFile = {
    name: 'write_wiki_file',
    description:
      'Create or overwrite a Markdown page inside the vault. `path` must start with `wiki/`, `derived/` or `_meta/`; writes to `raw/` are rejected. The previous version (when one exists) is copied to `_meta/versions/` before writing. Pages are never deleted: pass the complete new body in `markdown`.',
    parameters: objectSchema({
      markdown: {
        type: 'string',
        description: 'Complete Markdown body of the page, including any frontmatter.',
      },
      path: {
        type: 'string',
        description: 'Vault-relative destination, starting with wiki/, derived/ or _meta/.',
      },
    }),
    output: {
      schema: objectSchema({
        path: { type: 'string', description: 'The vault-relative path that was written.' },
        action: { type: 'string', enum: ['created', 'updated'], description: 'Whether the page existed before.' },
        backup: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description: 'Vault-relative path of the backup copy, or null for a new page.',
        },
        bytes: { type: 'number', description: 'Number of UTF-8 bytes written.' },
      }),
      render: (args, value) => asJson(value),
    },
    async execute(args, exec) {
      const input = args ?? {}
      if (typeof input.markdown !== 'string') throw new Error('markdown must be a string')
      const relative = normalizeRelPath(input.path)
      if (!WRITE_PREFIXES.some((prefix) => relative.startsWith(prefix))) {
        throw new Error(`path must start with one of ${WRITE_PREFIXES.join(', ')}: ${relative}`)
      }
      const root = await resolveVaultRoot(ctx, toolConfig, exec)
      const absolute = resolveInVault(root, relative)

      let backup = null
      if (await pathExists(absolute)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const backupRelative = `_meta/versions/${relative.replace(/\//g, '__')}.${stamp}.md`
        const backupAbsolute = resolveInVault(root, backupRelative)
        await mkdir(dirname(backupAbsolute), { recursive: true })
        await copyFile(absolute, backupAbsolute)
        backup = backupRelative
      }

      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, input.markdown, 'utf8')
      return {
        path: relative,
        action: backup === null ? 'created' : 'updated',
        backup,
        bytes: Buffer.byteLength(input.markdown, 'utf8'),
      }
    },
  }

  const routine = {
    name: 'kb_routine',
    description:
      'Load one of the vault compiler routines as Markdown: `daily-compile` (fetch news, compile new raw notes, write the daily timeline), `weekly-lint` (suggest-only health check written to _meta/lint-report.md) or `query` (answer a question from the wiki and store the answer under derived/). `compile-rules` returns the always-on compilation rules. Load the routine before running it, then follow it step by step.',
    parameters: objectSchema({
      name: {
        type: 'string',
        description: 'Which routine to load.',
        enum: [...ROUTINES, 'compile-rules'],
      },
    }),
    output: {
      schema: objectSchema({
        name: { type: 'string', description: 'The routine that was loaded.' },
        markdown: { type: 'string', description: 'Full routine instructions.' },
      }),
      render: (args, value) => asJson(value),
    },
    async execute(args) {
      const input = args ?? {}
      if (input.name === 'compile-rules') {
        return { name: 'compile-rules', markdown: readPrompt('sections/compile-rules.md') }
      }
      if (!ROUTINES.includes(input.name)) {
        throw new Error(`unknown routine: ${String(input.name)}; expected one of ${ROUTINES.join(', ')}`)
      }
      return { name: input.name, markdown: readPrompt(`routines/${input.name}.md`) }
    },
  }

  return [fetchAiNews, readWikiIndex, searchWiki, readWikiFile, writeWikiFile, routine]
}

function extractFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  return match ? match[1] : null
}

function buildMatcher(query) {
  try {
    return new RegExp(query, 'im')
  } catch {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(escaped, 'im')
  }
}

// ---------------------------------------------------------------------------
// prompt section
// ---------------------------------------------------------------------------

const PROMPT_SECTION_NAME = 'wiki-compiler'

function compileRulesPrompt() {
  const rules = readPrompt('sections/compile-rules.md').trim()
  const routines = ROUTINES.map((routineName) => `\`${routineName}\``).join('、')
  return [
    rules,
    '',
    '## 工具',
    '',
    '- `read_wiki_index` 每次编译第一步调用，返回 `wiki/index.md` 与 `_meta/manifest.json` 中未编译的 raw 条目。',
    '- `search_wiki` / `read_wiki_file` 写任何页面前必须先搜索、再读 2–5 篇相关页面。',
    '- `write_wiki_file` 只允许写 `wiki/`、`derived/`、`_meta/`；旧版本自动备份到 `_meta/versions/`；`raw/` 只读。',
    '- `fetch_ai_news` 抓取近 `hoursBack` 小时 AI 新闻，只获取不总结；单源失败不阻塞。',
    `- \`kb_routine\` 按需加载 ${routines} 三套例行流程（不常驻提示词）。`,
    '',
    '执行例行流程前先调用 `kb_routine` 取回步骤，再严格按步骤执行。',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// bundle entry
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const resolved = { ...config }
  for (const tool of createTools(ctx, resolved)) {
    ctx.effect(() => ctx.tools.register(tool))
  }

  if (resolved.registerPrompt === false) return
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : ctx.systemPrompt
  if (!systemPrompt) return
  ctx.effect(() =>
    systemPrompt.section({
      name: PROMPT_SECTION_NAME,
      order: 40,
      text: () => compileRulesPrompt(),
    }),
  )
}
