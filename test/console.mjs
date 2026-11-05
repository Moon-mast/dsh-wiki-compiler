// Node-side unit test for the browser half. The real browser half is delivered
// through `window.__ModuleLoader__`, so this harness provides that global and a
// minimal React stub, then exercises the pure helpers exported via `__test`.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', 'client', 'console.js');

let captured;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition;
    },
  },
};

const source = await readFile(clientPath, 'utf8');
assert.match(source, /window\.__ModuleLoader__\.load\(/, 'client halves must register through the module loader');
assert.doesNotMatch(
  source,
  /require\(['"]@deepseek-ai\/dsh-client-[^'"]+['"]\)/,
  'a plain-JS client half must not import Harness client packages',
);

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useCallback: (fn) => fn,
  useEffect: () => undefined,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => undefined],
};
const fakeRequire = (specifier) => {
  if (specifier === 'react') return fakeReact;
  throw new Error(`unexpected require(${specifier})`);
};

await import(`${pathToFileURL(clientPath).href}?t=${Date.now()}`);
assert.ok(captured, 'the module loader was expected to receive a definition');
assert.equal(captured.id, 'dsh-wiki-compiler', 'client id must equal the package name');

const client = captured.factory(fakeRequire);
const { redact, clip, summarizeArguments, extractText, lineForEvent, formatLine, turnEndKind, ROUTINE_INSTRUCTIONS } =
  client.__test;

assert.equal(typeof client.apply, 'function');
assert.deepEqual(client.inject, ['slots', 'locale', 'sessions']);

// --- secret redaction -------------------------------------------------------
assert.equal(redact('api_key=sk-abcdef1234567890'), 'api_key=***');
assert.equal(redact('token: ghp_abcdefghijklmnopqrst'), 'token=***');
assert.equal(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload'), 'Authorization=***');
assert.equal(redact('deepseekApiKey=abcdef123456'), 'deepseekApiKey=***');
assert.equal(redact('普通日志没有任何密钥'), '普通日志没有任何密钥');

// --- clipping / argument summarising ---------------------------------------
assert.ok(!clip('x'.repeat(500)).includes('x'.repeat(210)));
assert.match(clip('x'.repeat(500), 10), /^x{10}…（已截断）$/);
assert.equal(summarizeArguments('{"path":"wiki/index.md","markdown":"# hi"}'), 'path=wiki/index.md markdown=# hi');
assert.equal(summarizeArguments('{"apiKey":"abcdef"}'), 'apiKey=***');
assert.equal(summarizeArguments('not json but has password=p@ssw0rd'), 'not json but has password=***');

// --- session event projection ---------------------------------------------
assert.deepEqual(extractText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb');
assert.equal(turnEndKind({ kind: 'completed' }), 'completed');
assert.equal(turnEndKind({ kind: 'error', error: { message: 'boom' } }), 'error');
assert.equal(turnEndKind(undefined), 'completed');

const start = lineForEvent({ type: 'turn/start', time: 1, data: { turn: 2 } });
assert.equal(start.text, 'turn/start:2');
const call = lineForEvent({
  type: 'tool/call',
  time: 2,
  data: { name: 'write_wiki_file', arguments: '{"path":"wiki/x.md","apiKey":"abcdef"}' },
});
assert.equal(call.level, 'info');
assert.equal(call.text, 'tool/call:write_wiki_file');
assert.match(call.args.summary, /apiKey=\*\*\*/);
const okResult = lineForEvent({
  type: 'tool/result',
  time: 3,
  data: { message: { role: 'tool', content: [{ type: 'text', text: 'written 512 bytes' }] } },
});
assert.equal(okResult.level, 'ok');
assert.match(okResult.args.summary, /written 512 bytes/);
const badResult = lineForEvent({
  type: 'tool/result',
  time: 4,
  data: { message: { role: 'tool', isError: true, content: [] }, error: { name: 'FsError', code: 'FS_DENIED' } },
});
assert.equal(badResult.level, 'error');
assert.equal(badResult.args.code, 'FS_DENIED');
const end = lineForEvent({ type: 'turn/end', time: 5, data: { turn: 1, reason: { kind: 'error', error: { message: 'x' } } } });
assert.equal(end.level, 'warn');
assert.equal(lineForEvent({ type: 'user/message', time: 6, data: {} }), null);

const text = formatLine({ kind: 'turn/start', time: Date.now(), extra: { turn: 3 } }, {
  turnStart: (n) => `▶ 第 ${n} 轮开始`,
  turnEnd: (k) => `■ ${k}`,
  toolCall: (n) => `🔧 ${n}`,
  toolOk: '✔',
  toolFail: '✖',
});
assert.match(text, /第 3 轮开始/);

// --- routines ---------------------------------------------------------------
for (const name of ['daily-compile', 'weekly-lint', 'query']) {
  assert.equal(typeof ROUTINE_INSTRUCTIONS[name], 'string');
  assert.ok(ROUTINE_INSTRUCTIONS[name].includes('kb_routine'), `${name} must tell the agent to load the routine`);
}

// --- registration contract --------------------------------------------------
const registrations = [];
const fakeCtx = {
  get(name) {
    if (name === 'locale') {
      return {
        register: (ns, dict) => {
          assert.equal(ns, 'dsh-wiki-compiler');
          assert.ok(dict.zh && dict.en);
          return () => undefined;
        },
        bind: (ns) => {
          assert.equal(ns, 'dsh-wiki-compiler');
          return () => ({ title: 'AI 日报控制台' });
        },
      };
    }
    return undefined;
  },
  effect: (fn) => fn(),
  slots: {
    inject: (slot, register) => {
      registrations.push(slot);
      return register();
    },
    register: (options, component) => ({ options, component }),
  },
};

const registered = client.apply(fakeCtx);
assert.equal(registered, undefined);
assert.deepEqual(registrations, ['conversation.composer.dock']);

console.log('console checks passed');
