// Browser half of dsh-wiki-compiler: the 「AI 日报」 sliding console.
//
// It is delivered through the Harness client module table: the shell injects
// `window.__ModuleLoader__` before this file runs and the factory below is the
// only entry point. The package name in `id` must equal the package name in
// package.json — that is how the client half is paired with the Host half.
//
// Design notes (see README, section 「控制台」):
//   * The console never imports a Harness client package. Only `require("react")`
//     is used; controls are hand-rolled with inline styles on `--dsw-alias-*`
//     tokens so the panel follows the active theme.
//   * Triggering a Routine is done through the sanctioned Client `sessions`
//     service: retain the current Session, then `session.prompt(...)` with the
//     Routine instruction. No local HTTP port, no fs access, no tool imports.
//   * Live logs are read from the retained Session's event source
//     (`SessionEventSource`), i.e. the same `session/event` feed the Host
//     records. Nothing is injected into the model context; the listener only
//     reads snapshots and never mutates them.
//   * Every effect is released on unmount: `reference.release()` plus the
//     `subscribe()` disposer returned by the snapshot APIs.

window.__ModuleLoader__.load({
  id: 'dsh-wiki-compiler',
  factory: (require) => {
    const React = require('react');
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'dsh-wiki-compiler';
    const CONSOLE_ID = 'wiki-compiler-console';
    const ROUTINE_INSTRUCTIONS = {
      'daily-compile':
        '请执行「AI 日报」每日编译 Routine：先调用 kb_routine({ name: "daily-compile" }) 读取完整步骤，然后严格按步骤执行。raw/ 只读，不得编造；矛盾写入 _meta/lint-report.md；结束时汇报 处理条数 / 新建页数 / 更新页数 / 矛盾条数。',
      'weekly-lint':
        '请执行「AI 日报」每周体检 Routine：先调用 kb_routine({ name: "weekly-lint" }) 读取完整步骤，然后严格按步骤执行。只输出建议、不修改 wiki 内容；结果写入 _meta/lint-report.md；若无问题写「本次检查通过」。',
      'query':
        '请执行「AI 日报」问答 Routine：先调用 kb_routine({ name: "query" }) 读取完整步骤，读取相关页面后再作答，引用使用 [[页面]] 形式，答案写入 derived/。不得编造，缺失信息要明确说明。',
    };

    const L = {
      zh: {
        title: 'AI 日报控制台',
        open: '展开',
        close: '收起',
        compile: '立即编译',
        lint: '运行 Lint',
        stop: '停止',
        idle: '空闲',
        running: '运行中',
        empty: '尚无日志。点击「立即编译」开始。',
        noSession: '当前会话不可用，无法启动 Routine。',
        busy: '当前会话仍在执行，请先停止或等待结束。',
        accepted: '已提交 Routine，等待 Agent 开始…',
        failed: '提交失败',
        stopped: '已请求停止',
        turnStart: (n) => `▶ 第 ${n} 轮开始`,
        turnEnd: (kind) => `■ 本轮结束（${kind}）`,
        toolCall: (name) => `🔧 ${name}`,
        toolOk: '✔ 完成',
        toolFail: '✖ 失败',
        cleared: '日志已清空',
      },
      en: {
        title: 'AI Daily console',
        open: 'Expand',
        close: 'Collapse',
        compile: 'Compile now',
        lint: 'Run lint',
        stop: 'Stop',
        idle: 'Idle',
        running: 'Running',
        empty: 'No log yet. Click “Compile now” to start.',
        noSession: 'This session is not available; cannot start the Routine.',
        busy: 'This session is still running; stop it or wait for the turn to end.',
        accepted: 'Routine submitted, waiting for the agent…',
        failed: 'Submit failed',
        stopped: 'Stop requested',
        turnStart: (n) => `▶ turn ${n} started`,
        turnEnd: (kind) => `■ turn ended (${kind})`,
        toolCall: (name) => `🔧 ${name}`,
        toolOk: '✔ ok',
        toolFail: '✖ failed',
        cleared: 'Log cleared',
      },
    };

    // ------------------------------------------------------------------
    // Pure text helpers (unit tested through `__test` below)
    // ------------------------------------------------------------------

    const SECRET_PATTERN =
      /(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)\s*[:=]\s*["']?([^\s"',;]+)/gi;

    function redact(input) {
      let text = typeof input === 'string' ? input : String(input ?? '');
      text = text.replace(/(authorization)\s*[:=]\s*bearer\s+[^\s"',;]+/gi, '$1=***');
      text = text.replace(SECRET_PATTERN, (_m, key) => `${key}=***`);
      text = text.replace(/\bBearer\s+[A-Za-z0-9_\-\.=+\/]{8,}/gi, 'Bearer ***');
      text = text.replace(/\bsk-[A-Za-z0-9]{8,}/g, 'sk-***');
      text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh***');
      return text;
    }

    function clip(text, limit) {
      const value = String(text ?? '');
      const max = typeof limit === 'number' && limit > 0 ? limit : 200;
      return value.length > max ? `${value.slice(0, max)}…（已截断）` : value;
    }

    function safeSummary(text, limit) {
      return clip(redact(text).replace(/\s+/g, ' ').trim(), limit);
    }

    function summarizeArguments(raw) {
      if (raw === undefined || raw === null || raw === '') return '';
      let parsed = raw;
      if (typeof raw === 'string') {
        try {
          parsed = JSON.parse(raw);
        } catch {
          return safeSummary(raw, 120);
        }
      }
      if (parsed === null || typeof parsed !== 'object') return safeSummary(parsed, 120);
      const parts = [];
      for (const key of Object.keys(parsed)) {
        const value = parsed[key];
        if (value === undefined) continue;
        if (/token|key|secret|password/i.test(key)) {
          parts.push(`${key}=***`);
          continue;
        }
        const shown = typeof value === 'string' ? safeSummary(value, 80) : safeSummary(JSON.stringify(value), 80);
        parts.push(`${key}=${shown}`);
      }
      return clip(parts.join(' '), 160);
    }

    function extractText(content) {
      if (!content) return '';
      const blocks = Array.isArray(content) ? content : [content];
      const chunks = [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') chunks.push(block.text);
      }
      return chunks.join('\n');
    }

    function turnEndKind(reason) {
      if (typeof reason === 'string') return reason;
      if (!reason || typeof reason !== 'object') return 'completed';
      if (typeof reason.kind === 'string') return reason.kind;
      if (typeof reason.reason === 'string') return reason.reason;
      return 'completed';
    }

    // Project one `session/event` entry into a console line. `calls` maps a
    // tool call id to its tool name so a later `tool/result` can name the tool
    // it belongs to (the result event itself only carries the tool call id).
    function lineForEvent(event, calls) {
      if (!event || typeof event.type !== 'string') return null;
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      const pending = calls && typeof calls.get === 'function' ? calls : null;
      switch (event.type) {
        case 'turn/start':
          return { kind: 'turn/start', level: 'run', extra: { turn: data.turn } };
        case 'turn/end': {
          const reason = turnEndKind(data.reason);
          return { kind: 'turn/end', level: reason === 'completed' ? 'ok' : 'warn', extra: { reason, turn: data.turn } };
        }
        case 'tool/call': {
          const callId = typeof data.callId === 'string' ? data.callId : undefined;
          if (pending && callId) pending.set(callId, data.name);
          return {
            kind: 'tool/call',
            level: 'info',
            extra: { name: data.name, summary: summarizeArguments(data.arguments) },
          };
        }
        case 'tool/result': {
          const message = data.message && typeof data.message === 'object' ? data.message : {};
          const callId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
          const name = (pending && callId && pending.get(callId)) || undefined;
          if (pending && callId) pending.delete(callId);
          const isError = Boolean(data.error) || Boolean(message.isError);
          const body = extractText(message.content);
          return {
            kind: isError ? 'tool/error' : 'tool/ok',
            level: isError ? 'error' : 'ok',
            extra: {
              name,
              code: data.error && data.error.code,
              reason: data.error && data.error.reason,
              summary: safeSummary(body, 200),
            },
          };
        }
        case 'assistant/error':
          return { kind: 'error', level: 'error', extra: { summary: safeSummary(JSON.stringify(data), 200) } };
        default:
          return null;
      }
    }

    function formatLine(entry, t) {
      if (!entry) return '';
      const { kind, text, extra } = entry;
      const time = new Date(entry.time).toLocaleTimeString();
      const named = (extra && extra.name) || '';
      switch (kind) {
        case 'turn/start':
          return `${time} ${t.turnStart(extra && extra.turn)}`;
        case 'turn/end':
          return `${time} ${t.turnEnd((extra && extra.reason) || 'completed')}`;
        case 'tool/call':
          return `${time} ${t.toolCall(named || '?')}${extra && extra.summary ? ` ${extra.summary}` : ''}`;
        case 'tool/ok':
          return `${time} ${t.toolOk}${named ? ` ${named}` : ''}${extra && extra.summary ? ` ${extra.summary}` : ''}`;
        case 'tool/error': {
          const detail = [named, extra && extra.reason, extra && extra.summary].filter(Boolean).join(' · ');
          return `${time} ${t.toolFail}${detail ? ` ${detail}` : ''}`;
        }
        default:
          return `${time} ${(extra && extra.summary) || text || ''}`;
      }
    }

    const MAX_LOG_LINES = 400;

    function pushLines(current, incoming) {
      if (!incoming.length) return current;
      const next = current.concat(incoming);
      return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        marginTop: '8px',
        fontFamily: 'inherit',
        fontSize: '13px',
        color: 'var(--dsw-alias-fg-primary, #1f2328)',
      },
      bar: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        padding: '6px 10px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,0.28))',
        background: 'var(--dsw-alias-bg-elevated, rgba(127,127,127,0.06))',
      },
      title: { fontWeight: 600, marginRight: 'auto' },
      chip: (tone) => ({
        padding: '1px 8px',
        borderRadius: '999px',
        fontSize: '12px',
        border: '1px solid transparent',
        background:
          tone === 'running'
            ? 'var(--dsw-alias-bg-accent, rgba(40,120,255,0.16))'
            : 'var(--dsw-alias-bg-elevated, rgba(127,127,127,0.12))',
        color: tone === 'running' ? 'var(--dsw-alias-fg-accent, #1a5fd0)' : 'var(--dsw-alias-fg-secondary, #57606a)',
      }),
      button: (primary, danger) => ({
        appearance: 'none',
        cursor: 'pointer',
        borderRadius: '8px',
        padding: '4px 12px',
        fontSize: '12px',
        lineHeight: '18px',
        border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,0.35))',
        background: danger
          ? 'var(--dsw-alias-bg-danger, rgba(220,60,60,0.12))'
          : primary
            ? 'var(--dsw-alias-bg-accent, rgba(40,120,255,0.16))'
            : 'transparent',
        color: danger
          ? 'var(--dsw-alias-fg-danger, #c62828)'
          : primary
            ? 'var(--dsw-alias-fg-accent, #1a5fd0)'
            : 'inherit',
      }),
      panel: {
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,0.28))',
        background: 'var(--dsw-alias-bg-elevated, rgba(127,127,127,0.06))',
        overflow: 'hidden',
      },
      log: {
        margin: 0,
        padding: '8px 10px',
        listStyle: 'none',
        maxHeight: '220px',
        overflowY: 'auto',
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: '12px',
        lineHeight: '18px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      empty: { padding: '12px', opacity: 0.65 },
      line: (level) => ({
        color:
          level === 'error'
            ? 'var(--dsw-alias-fg-danger, #c62828)'
            : level === 'warn'
              ? 'var(--dsw-alias-fg-warning, #9a6700)'
              : level === 'ok'
                ? 'var(--dsw-alias-fg-success, #1a7f37)'
                : 'inherit',
        opacity: level === 'info' ? 0.85 : 1,
      }),
    };

    // ------------------------------------------------------------------
    // Console component
    // ------------------------------------------------------------------

    function ConsoleDock(props) {
      const sessionId = props && props.sessionId;
      const ctx = props && props.__ctx ? props.__ctx : undefined;
      const t = (props && props.__t) || L.zh;
      const [expanded, setExpanded] = useState(false);
      const [logs, setLogs] = useState([]);
      const [running, setRunning] = useState(false);
      const [busy, setBusy] = useState(false);
      const referenceRef = useRef(null);
      const logRef = useRef(null);
      const setLogsRef = useRef(setLogs);
      setLogsRef.current = setLogs;

      const append = useCallback((entries) => {
        if (!entries || !entries.length) return;
        setLogsRef.current((current) => pushLines(current, entries));
      }, []);

      // Retain the Session for the lifetime of this mounted entry. The
      // disposer releases the reference, which detaches both subscriptions.
      useEffect(() => {
        const sessions = ctx && ctx.get ? ctx.get('sessions') : undefined;
        if (!sessions || !sessionId) return undefined;
        const reference = sessions.retain(sessionId, { source: 'controllerOperation' });
        referenceRef.current = reference;
        let disposed = false;
        let unsubscribeEvents = null;
        let unsubscribeSession = null;
        let lastSeq = -1;

        const calls = new Map();
        const onEventWindow = () => {
          const binding = referenceRef.current && referenceRef.current.binding;
          if (!binding || !binding.eventSource) return;
          const window = binding.eventSource.getSnapshot();
          if (!window || !Array.isArray(window.entries)) return;
          const fresh = [];
          for (const entry of window.entries) {
            if (!entry || entry.type !== 'event' || !entry.event) continue;
            const event = entry.event;
            const seq = typeof event.seq === 'number' ? event.seq : 0;
            if (seq <= lastSeq) continue;
            lastSeq = seq;
            const mapped = lineForEvent(event, calls);
            if (!mapped) continue;
            fresh.push({ kind: mapped.kind, level: mapped.level, extra: mapped.extra, time: event.time || Date.now() });
          }
          append(fresh);
          const snapshot = binding.session && binding.session.getSnapshot ? binding.session.getSnapshot() : null;
          if (snapshot) setRunning(Boolean(snapshot.running));
        };

        const onSessionSnapshot = () => {
          const binding = referenceRef.current && referenceRef.current.binding;
          if (!binding || !binding.session || !binding.session.getSnapshot) return;
          const snapshot = binding.session.getSnapshot();
          if (!snapshot) return;
          setRunning(Boolean(snapshot.running));
          if (snapshot.lastAgentError) {
            append([
              { kind: 'text', level: 'error', extra: {}, time: Date.now(), text: safeSummary(String(snapshot.lastAgentError), 200) },
            ]);
          }
        };

        reference.ready.then(
          (binding) => {
            if (disposed) return;
            if (binding && binding.eventSource) unsubscribeEvents = binding.eventSource.subscribe(onEventWindow);
            if (binding && binding.session) unsubscribeSession = binding.session.subscribe(onSessionSnapshot);
            onEventWindow();
          },
          (error) => {
            if (disposed) return;
            append([
              { kind: 'text', level: 'error', extra: {}, time: Date.now(), text: safeSummary(String(error && error.message ? error.message : error), 160) },
            ]);
          },
        );

        return () => {
          disposed = true;
          if (unsubscribeEvents) unsubscribeEvents();
          if (unsubscribeSession) unsubscribeSession();
          reference.release();
          referenceRef.current = null;
        };
      }, [ctx, sessionId, append]);

      useEffect(() => {
        if (!expanded) return;
        const node = logRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      }, [expanded, logs]);

      const start = useCallback(
        async (routine) => {
          const reference = referenceRef.current;
          const binding = reference && reference.binding;
          if (!binding || !binding.session) {
            append([{ kind: 'text', level: 'error', extra: {}, time: Date.now(), text: t.noSession }]);
            setExpanded(true);
            return;
          }
          const snapshot = binding.session.getSnapshot ? binding.session.getSnapshot() : null;
          if (snapshot && snapshot.running) {
            append([{ kind: 'text', level: 'warn', extra: {}, time: Date.now(), text: t.busy }]);
            setExpanded(true);
            return;
          }
          const instruction = ROUTINE_INSTRUCTIONS[routine];
          if (!instruction) return;
          setBusy(true);
          setExpanded(true);
          setLogs([]);
          append([{ kind: 'text', level: 'run', extra: {}, time: Date.now(), text: `${routine} · ${t.accepted}` }]);
          try {
            const result = await binding.session.prompt([{ type: 'text', text: instruction }], 'queue');
            if (result && result.ok === false) {
              const failure = result.error || {};
              append([
                {
                  kind: 'text',
                  level: 'error',
                  extra: {},
                  time: Date.now(),
                  text: `${t.failed}: ${safeSummary(String(failure.message || failure.code || 'unknown'), 160)}`,
                },
              ]);
            }
          } catch (error) {
            append([
              {
                kind: 'text',
                level: 'error',
                extra: {},
                time: Date.now(),
                text: `${t.failed}: ${safeSummary(String(error && error.message ? error.message : error), 160)}`,
              },
            ]);
          } finally {
            setBusy(false);
          }
        },
        [append, t],
      );

      const stop = useCallback(async () => {
        const reference = referenceRef.current;
        const binding = reference && reference.binding;
        if (!binding || !binding.session || !binding.session.cancel) return;
        try {
          await binding.session.cancel();
          append([{ kind: 'text', level: 'warn', extra: {}, time: Date.now(), text: t.stopped }]);
        } catch (error) {
          append([
            {
              kind: 'text',
              level: 'error',
              extra: {},
              time: Date.now(),
              text: safeSummary(String(error && error.message ? error.message : error), 160),
            },
          ]);
        }
      }, [append, t]);

      const label = useMemo(() => (running ? t.running : t.idle), [running, t]);

      return h(
        'div',
        { style: S.root, 'data-dsh-wiki-console': CONSOLE_ID },
        h(
          'div',
          { style: S.bar },
          h('span', { style: S.title }, t.title),
          h('span', { style: S.chip(running ? 'running' : 'idle') }, label),
          h(
            'button',
            {
              type: 'button',
              style: S.button(true, false),
              disabled: running || busy,
              onClick: () => start('daily-compile'),
            },
            t.compile,
          ),
          h(
            'button',
            { type: 'button', style: S.button(false, false), disabled: running || busy, onClick: () => start('weekly-lint') },
            t.lint,
          ),
          h(
            'button',
            {
              type: 'button',
              style: S.button(false, true),
              disabled: !running,
              onClick: () => stop(),
            },
            t.stop,
          ),
          h(
            'button',
            { type: 'button', style: S.button(false, false), onClick: () => setExpanded((value) => !value) },
            expanded ? t.close : t.open,
          ),
        ),
        expanded
          ? h(
              'div',
              { style: S.panel },
              logs.length === 0
                ? h('div', { style: S.empty }, t.empty)
                : h(
                    'ul',
                    { style: S.log, ref: logRef },
                    logs.map((entry, index) =>
                      h('li', { key: `${entry.time}-${index}`, style: S.line(entry.level) }, formatLine(entry, t)),
                    ),
                  ),
            )
          : null,
      );
    }

    // ------------------------------------------------------------------
    // Plugin
    // ------------------------------------------------------------------

    function apply(ctx) {
      const locale = ctx.get('locale');
      const t = (() => {
        if (!locale || typeof locale.register !== 'function' || typeof locale.bind !== 'function') {
          return () => L.zh;
        }
        try {
          ctx.effect(() => locale.register(NS, { zh: L.zh, en: L.en }));
          const bound = locale.bind(NS);
          return typeof bound === 'function' ? bound : () => L.zh;
        } catch {
          return () => L.zh;
        }
      })();

      const makeComponent = (props) =>
        h(ConsoleDock, {
          sessionId: props && props.sessionId,
          __ctx: ctx,
          __t: t(),
        });

      ctx.effect(() =>
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: CONSOLE_ID,
              order: 20,
              label: () => t().title,
              locale: NS,
            },
            makeComponent,
          ),
        ),
      );
    }

    return {
      name: 'dsh-wiki-compiler/client',
      // Only `slots` is required for activation; `locale` and `sessions` are
      // looked up lazily so a missing optional service never blocks the panel.
      inject: ['slots'],
      apply,
      // Exposed for the repository's Node-side unit tests only.
      __test: { redact, clip, summarizeArguments, extractText, lineForEvent, formatLine, turnEndKind, ROUTINE_INSTRUCTIONS },
    };
  },
});
