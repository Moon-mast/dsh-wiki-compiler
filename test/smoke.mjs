/**
 * Offline smoke test: mounts the bundle against a fake Cordis context, exercises
 * every tool on a throwaway vault, and validates each result against the tool's own
 * output schema (mirroring the Harness registry, which validates before rendering).
 *
 * Run with: node test/smoke.mjs
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply, name } = await import('../index.js')

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// minimal JSON Schema validator covering the subset the bundle authors
// ---------------------------------------------------------------------------

function validate(schema, value, path = '$') {
  if (schema.oneOf) {
    const matched = schema.oneOf.some((candidate) => validate(candidate, value, path).length === 0)
    return matched ? [] : [`${path}: matches no oneOf branch`]
  }
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: not in enum`]
  if (schema.const !== undefined && schema.const !== value) return [`${path}: const mismatch`]
  if (schema.type) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const expected = schema.type === 'integer' ? 'number' : schema.type
    if (actual !== expected) return [`${path}: expected ${schema.type}, got ${actual}`]
  }
  const errors = []
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: missing required property`)
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key]
      if (!childSchema) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: unexpected property`)
        continue
      }
      errors.push(...validate(childSchema, child, `${path}.${key}`))
    }
  }
  if (schema.type === 'array' && schema.items) {
    value.forEach((entry, index) => errors.push(...validate(schema.items, entry, `${path}[${index}]`)))
  }
  return errors
}

// ---------------------------------------------------------------------------
// fake context + fixture vault
// ---------------------------------------------------------------------------

const registrations = new Map()
const sections = []
const ctx = {
  tools: {
    register(definition) {
      registrations.set(definition.name, definition)
      return () => registrations.delete(definition.name)
    },
  },
  effect(setup) {
    setup()
  },
  get(service) {
    if (service === 'workingDirectory') {
      return { defaultDirectory: vault, ensure: async () => vault }
    }
    if (service === 'systemPrompt') {
      return { section: (section) => (sections.push(section), () => {}) }
    }
    return undefined
  },
}

const vault = await mkdtemp(join(tmpdir(), 'dsh-wiki-compiler-'))
await mkdir(join(vault, 'raw', '2026-03-01'), { recursive: true })
await mkdir(join(vault, 'wiki', 'concepts'), { recursive: true })
await mkdir(join(vault, 'wiki', 'sources'), { recursive: true })
await mkdir(join(vault, '_meta'), { recursive: true })

await writeFile(join(vault, 'raw', '2026-03-01', 'rag.md'), '# RAG\n\n检索增强生成。\n', 'utf8')
await writeFile(join(vault, 'raw', '2026-03-01', 'agents.md'), '# Agents\n\n智能体。\n', 'utf8')
await writeFile(
  join(vault, '_meta', 'manifest.json'),
  JSON.stringify({
    version: 1,
    entries: [
      { path: 'raw/2026-03-01/rag.md', date: '2026-03-01', compiled: false, destinations: [] },
      { path: 'raw/2026-03-01/agents.md', date: '2026-03-01', compiled: true, destinations: ['wiki/concepts/agents.md'] },
    ],
  }),
  'utf8',
)
await writeFile(join(vault, 'wiki', 'index.md'), '# 索引\n\n- [[concepts/rag]]\n', 'utf8')
await writeFile(
  join(vault, 'wiki', 'concepts', 'rag.md'),
  '---\ntitle: RAG\nupdated: 2026-03-01\n---\n\nRAG 是检索增强生成。\n\n## 要点\n\n- 检索后生成\n',
  'utf8',
)

console.log(`\nmounting ${name}`)
apply(ctx, {})
check('registers six tools', registrations.size === 6, [...registrations.keys()].join(', '))
check('registers one prompt section', sections.length === 1)
check('prompt section mentions rules', typeof sections[0]?.text() === 'string' && sections[0].text().includes('raw/'))

const exec = { agent: { id: 'session-test' }, signal: new AbortController().signal }

async function call(toolName, args) {
  const definition = registrations.get(toolName)
  const value = await definition.execute(args, exec)
  const schemaErrors = validate(definition.output.schema, value)
  check(`${toolName} output matches its schema`, schemaErrors.length === 0, schemaErrors.join('; '))
  const rendered = definition.output.render(args, value)
  check(`${toolName} renders text`, Array.isArray(rendered) && rendered[0]?.type === 'text')
  return value
}

console.log('\nread_wiki_index')
const index = await call('read_wiki_index', {})
check('returns index text', index.index.includes('索引'))
check('returns only uncompiled raw entries', index.uncompiled.length === 1 && index.uncompiled[0].path === 'raw/2026-03-01/rag.md')
check('keeps the manifest date', index.uncompiled[0].date === '2026-03-01')

console.log('\nsearch_wiki')
const matches = await call('search_wiki', { query: '检索增强' })
check('finds the concept page', matches.some((match) => match.path === 'wiki/concepts/rag.md'))
const scoped = await call('search_wiki', { query: 'agents', scope: 'sources' })
check('scope narrows the search', scoped.length === 0)

console.log('\nread_wiki_file')
const page = await call('read_wiki_file', { path: 'wiki/concepts/rag.md' })
check('returns full content', page.content.includes('## 要点'))
check('extracts frontmatter', page.frontmatter?.includes('title: RAG'))

console.log('\nwrite_wiki_file')
const created = await call('write_wiki_file', { path: 'wiki/concepts/graphrag.md', markdown: '# GraphRAG\n\n图检索增强。\n' })
check('reports a create', created.action === 'created' && created.backup === null)
const updated = await call('write_wiki_file', { path: 'wiki/concepts/rag.md', markdown: '# RAG\n\n更新后的定义。\n' })
check('reports an update with a backup', updated.action === 'updated' && typeof updated.backup === 'string')
const backup = await readFile(join(vault, updated.backup), 'utf8')
check('backup keeps the previous body', backup.includes('检索后生成'))

let rejected = false
try {
  await registrations.get('write_wiki_file').execute({ path: 'raw/2026-03-01/rag.md', markdown: 'x' }, exec)
} catch {
  rejected = true
}
check('rejects writes to raw/', rejected)

let traversalRejected = false
try {
  await registrations.get('write_wiki_file').execute({ path: 'wiki/../../escape.md', markdown: 'x' }, exec)
} catch {
  traversalRejected = true
}
check('rejects path traversal', traversalRejected)

console.log('\nkb_routine')
for (const routineName of ['daily-compile', 'weekly-lint', 'query', 'compile-rules']) {
  const routine = await call('kb_routine', { name: routineName })
  check(`loads ${routineName}`, routine.markdown.length > 200)
}

console.log('\nfetch_ai_news')
const news = await call('fetch_ai_news', { feeds: [{ name: 'offline', url: 'http://127.0.0.1:9/none.xml' }], hoursBack: 24 })
check('a failing feed never fails the call', news.items.length === 0 && news.failedSources.length === 1)
check('reports the failing feed', news.failedSources[0].name === 'offline')

await rm(vault, { recursive: true, force: true })

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
