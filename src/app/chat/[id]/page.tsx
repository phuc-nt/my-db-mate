'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { use, useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { QueryResultBlock } from '../../../components/query-result-block';
import { ChatArtifactChip, type ChatArtifact } from '../../../components/chat-artifact-chip';
import { ChatWorkspacePanel, ChatSessionRail } from '../../../components/chat-workspace-panel';

/** Shape of a streamed run_sql tool part (subset we read). */
interface RunSqlPart {
  state?: string;
  toolCallId: string;
  input?: { sql?: string };
  output?: { columns?: string[]; rows?: unknown[][]; executedSql?: string; blocked?: boolean; reason?: string; error?: string; note?: string };
}

export default function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: connectionId } = use(params);
  const [input, setInput] = useState('');
  const [investigate, setInvestigate] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const [distillMsg, setDistillMsg] = useState('');
  const [dialect, setDialect] = useState<'postgres' | 'mysql' | 'sqlite' | 'mssql'>();

  // Workspace selection. followLatest = terminal-style auto-follow: new results
  // select themselves unless the user has clicked back to an older artifact.
  const [selected, setSelected] = useState<string | null>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const [unseen, setUnseen] = useState<Set<string>>(new Set());

  // Starter questions for the empty state (verified-first, no LLM).
  const [starters, setStarters] = useState<string[]>([]);
  useEffect(() => {
    fetch(`/api/connections/${connectionId}/starter-questions`)
      .then((r) => r.json()).then((d) => setStarters(Array.isArray(d.questions) ? d.questions : []))
      .catch(() => {});
  }, [connectionId]);

  // Follow-up question suggestions after a completed turn.
  const [followups, setFollowups] = useState<string[]>([]);
  const [followupsOn, setFollowupsOn] = useState(true);
  const followupMsgIdRef = useRef<string | null>(null); // dedupe: one fetch per assistant turn
  const followupAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    setFollowupsOn(localStorage.getItem('mdm.followups') !== 'off');
  }, []);

  // Create a session for this chat so queries + transcript can be distilled later.
  useEffect(() => {
    fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionId }) })
      .then((r) => r.json()).then((s) => setSessionId(s.id));
    // Dialect drives dialect-aware SQL-insert export in result blocks.
    fetch(`/api/connections/${connectionId}/schema`).then((r) => r.json()).then((d) => setDialect(d.dialect)).catch(() => {});
  }, [connectionId]);

  const { messages, sendMessage, addToolResult, status } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      body: { connectionId, sessionId },
    }),
    // When the model calls ask_user (a no-execute tool), the stream stops at that
    // tool-call; we render the question and resume via addToolResult below.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  const busy = status === 'submitted' || status === 'streaming';

  // The workspace artifacts ARE the run_sql parts of the transcript — derived,
  // never duplicated into separate state.
  const artifacts = useMemo<ChatArtifact[]>(() => {
    const list: ChatArtifact[] = [];
    for (const m of messages) {
      for (const part of m.parts) {
        if (part.type !== 'tool-run_sql') continue;
        const p = part as unknown as RunSqlPart;
        if (p.state !== 'output-available') continue;
        list.push({
          toolCallId: p.toolCallId,
          sql: p.input?.sql ?? '',
          columns: p.output?.columns,
          rows: p.output?.rows,
          executedSql: p.output?.executedSql,
          blocked: p.output?.blocked,
          blockedReason: p.output?.reason,
          error: p.output?.error,
          // No columns + not blocked/error = the tool returned without executing
          // (budget stop or risk tier awaiting confirmation) — chip shows "not run".
          notRunReason: !p.output?.columns && !p.output?.blocked && !p.output?.error
            ? (p.output?.reason ?? p.output?.note) : undefined,
          index: list.length + 1,
        });
      }
    }
    return list;
  }, [messages]);

  // Auto-follow the newest artifact; when the user is parked on an older one,
  // mark newer arrivals with a dot instead of yanking the panel.
  const lastId = artifacts.length > 0 ? artifacts[artifacts.length - 1].toolCallId : null;
  const prevLastRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastId === prevLastRef.current) return;
    prevLastRef.current = lastId;
    if (!lastId) return;
    if (followLatest) {
      setSelected(lastId);
      setUnseen((u) => (u.has(lastId) ? new Set([...u].filter((x) => x !== lastId)) : u));
    } else {
      setUnseen((u) => new Set(u).add(lastId));
    }
  }, [lastId, followLatest]);

  function selectArtifact(toolCallId: string) {
    setSelected(toolCallId);
    setFollowLatest(toolCallId === lastId);
    setUnseen((u) => (u.has(toolCallId) ? new Set([...u].filter((x) => x !== toolCallId)) : u));
  }

  // Fetch follow-up suggestions once a turn is TRULY complete. `status==='ready'`
  // recurs at every tool-step boundary mid-turn, so we also require the last
  // message to be an assistant message whose final part is text (no pending
  // tool-call awaiting auto-send), and dedupe by that message id.
  useEffect(() => {
    if (!followupsOn || status !== 'ready') return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const lastPart = last.parts[last.parts.length - 1];
    if (lastPart?.type !== 'text') return;           // still mid-turn (tool-call pending)
    if (followupMsgIdRef.current === last.id) return; // already fetched for this turn
    followupMsgIdRef.current = last.id;

    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const question = lastUser?.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(' ') ?? '';
    if (!question) return;
    const columns = artifacts.length ? artifacts[artifacts.length - 1].columns : undefined;

    followupAbortRef.current?.abort();
    const ac = new AbortController();
    followupAbortRef.current = ac;
    fetch(`/api/connections/${connectionId}/followups`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, columns }), signal: ac.signal,
    })
      .then((r) => r.json())
      .then((d) => setFollowups(Array.isArray(d.followups) ? d.followups : []))
      .catch(() => { /* aborted or failed — leave chips empty */ });
  }, [status, messages, followupsOn, connectionId, artifacts]);

  /** Send a turn, optionally in investigate mode (deeper multi-step analysis). */
  function send(text: string, mode: 'chat' | 'investigate' = 'chat') {
    // Clear + abort any pending follow-up fetch so stale chips don't repopulate
    // the turn the user just moved past (covers typed sends AND chip clicks).
    setFollowups([]);
    followupAbortRef.current?.abort();
    setFollowLatest(true);
    sendMessage({ text }, { body: { connectionId, sessionId, mode } });
  }

  function toggleFollowups() {
    setFollowupsOn((on) => {
      const next = !on;
      localStorage.setItem('mdm.followups', next ? 'on' : 'off');
      if (!next) setFollowups([]);
      return next;
    });
  }

  const analyzeDeeper = (sql: string) =>
    send(`Analyze this result more deeply — trends, comparisons, and anomalies. The query was: ${sql}`, 'investigate');

  async function distill() {
    if (!sessionId) return;
    setDistillMsg('Distilling…');
    const r = await fetch(`/api/sessions/${sessionId}/distill`, { method: 'POST' });
    const d = await r.json();
    setDistillMsg(d.created != null ? `${d.created} suggestion(s) added to Context Studio inbox` : `error: ${d.error}`);
  }

  async function saveNotebook() {
    if (!sessionId) return;
    const title = prompt('Notebook title:', 'Analysis notebook');
    if (!title) return;
    setDistillMsg('Saving notebook…');
    const r = await fetch('/api/notebooks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId, sessionId, title }),
    });
    const d = await r.json();
    setDistillMsg(d.id ? `Saved — open it at /notebooks/${d.id}` : `error: ${d.error}`);
  }

  return (
    // 1 column (<lg): results inline in the transcript, as before.
    // 2 columns (lg): chat | workspace-with-tab-strip.
    // 3 columns (2xl): chat | workspace | session rail.
    // The 3rem offset matches the fixed h-12 bar in components/app-nav.tsx.
    <main className="mx-auto h-[calc(100dvh-3rem)] max-w-4xl p-4 lg:grid lg:max-w-none lg:grid-cols-[minmax(340px,2fr)_3fr] lg:gap-4 2xl:grid-cols-[minmax(360px,1fr)_2fr_230px]">
      <div className="flex h-full min-h-0 flex-col">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Chat</h1>
          <div className="flex items-center gap-3 text-sm">
            {distillMsg && <span className="text-xs text-neutral-500">{distillMsg}</span>}
            <button onClick={toggleFollowups} className={followupsOn ? 'text-blue-600' : 'text-neutral-400'} title="Suggest follow-up questions after each answer">Follow-ups {followupsOn ? 'on' : 'off'}</button>
            <button onClick={saveNotebook} disabled={!sessionId || messages.length === 0} className="text-blue-600 disabled:opacity-40">Save as notebook</button>
            <button onClick={distill} disabled={!sessionId || messages.length === 0} className="text-blue-600 disabled:opacity-40">Distill to context</button>
            <Link href={`/browse/${connectionId}`} className="text-blue-600">Browse</Link>
            <Link href={`/context-studio/${connectionId}`} className="text-blue-600">Context</Link>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          {messages.length === 0 && (
            <div className="text-sm text-neutral-500">
              <p className="mb-2">Ask a question about your database. The assistant explores the schema and runs read-only SQL.</p>
              {starters.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {starters.map((q, i) => (
                    <button key={i} onClick={() => send(q)}
                      className="rounded-full border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 hover:border-blue-500 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300">
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'text-right' : ''}>
              <div className={`inline-block max-w-full rounded-lg px-3 py-2 text-sm ${m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-neutral-100 dark:bg-neutral-800'}`}>
                {m.parts.map((part, i) => {
                  if (part.type === 'text') {
                    if (m.role === 'user') return <span key={i} className="whitespace-pre-wrap">{part.text}</span>;
                    return (
                      <div key={i} className="report-markdown max-w-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
                      </div>
                    );
                  }
                  if (part.type === 'tool-run_sql') {
                    const p = part as unknown as RunSqlPart;
                    // While the tool input is still streaming, show a placeholder —
                    // only mount the (stateful) result block once we have the real SQL,
                    // so its initial SQL isn't frozen empty (browser-tested fix).
                    if (p.state !== 'output-available') {
                      return <div key={i} className="mt-1 text-xs text-neutral-400">⏳ running SQL…</div>;
                    }
                    const out = p.output;
                    const ok = out && !out.blocked && !out.error && out.columns;
                    const artifact = artifacts.find((a) => a.toolCallId === p.toolCallId);
                    return (
                      <div key={i}>
                        {/* Wide layouts: compact chip; the result lives in the panel. */}
                        {artifact && (
                          <div className="hidden lg:block">
                            <ChatArtifactChip artifact={artifact} active={selected === p.toolCallId} onClick={() => selectArtifact(p.toolCallId)} />
                          </div>
                        )}
                        {/* Narrow layouts: full inline block, exactly as before. */}
                        <div className="lg:hidden">
                          <QueryResultBlock
                            connectionId={connectionId}
                            dialect={dialect}
                            sessionId={sessionId}
                            initialSql={out?.executedSql ?? p.input?.sql ?? ''}
                            initialResult={ok ? { columns: out!.columns!, rows: out!.rows ?? [], executedSql: out!.executedSql } : undefined}
                            initialBlockedReason={out?.blocked ? out.reason : undefined}
                            initialError={out?.error}
                          />
                          {ok && !busy && (
                            <button onClick={() => analyzeDeeper(out!.executedSql ?? p.input?.sql ?? '')}
                              className="mt-1 text-xs text-blue-600 hover:underline">🔎 Analyze deeper</button>
                          )}
                        </div>
                      </div>
                    );
                  }
                  // plan_analysis: static display of the investigation plan (M6 — an
                  // echo tool cannot drive a live-ticking checklist, so show it as-is).
                  if (part.type === 'tool-plan_analysis') {
                    const p = part as unknown as { input?: { steps?: string[] } };
                    const steps = p.input?.steps ?? [];
                    if (steps.length === 0) return null;
                    return (
                      <div key={i} className="mt-1 rounded border border-blue-200 bg-blue-50 p-2 text-xs dark:border-blue-900 dark:bg-blue-950">
                        <div className="mb-1 font-medium">📋 Analysis plan</div>
                        <ol className="list-decimal pl-4">{steps.map((s, j) => <li key={j}>{s}</li>)}</ol>
                      </div>
                    );
                  }
                  // ask_user: no-execute tool → the stream paused here waiting for the
                  // human. Render the question; the answer resumes the loop (C1).
                  if (part.type === 'tool-ask_user') {
                    const p = part as unknown as { state?: string; toolCallId: string; input?: { question?: string; options?: string[] } };
                    if (p.state === 'output-available') {
                      return <div key={i} className="mt-1 text-xs text-neutral-500">✓ answered: {p.input?.question}</div>;
                    }
                    const answer = (text: string) => addToolResult({ tool: 'ask_user', toolCallId: p.toolCallId, output: text });
                    return (
                      <AskUserBox key={i} question={p.input?.question ?? ''} options={p.input?.options} onAnswer={answer} disabled={busy} />
                    );
                  }
                  // Reasoning stream (models that emit it) — collapsible, non-load-bearing.
                  if (part.type === 'reasoning') {
                    const text = (part as unknown as { text?: string }).text ?? '';
                    if (!text.trim()) return null;
                    return (
                      <details key={i} className="mt-1 rounded bg-black/5 p-1 text-xs text-neutral-500 dark:bg-white/10">
                        <summary className="cursor-pointer">💭 Thinking</summary>
                        <div className="mt-1 whitespace-pre-wrap">{text}</div>
                      </details>
                    );
                  }
                  // Generic tool step (the tools without an explicit branch above):
                  // friendly label + running/done/error status.
                  if (part.type.startsWith('tool-')) {
                    const p = part as unknown as { type: string; state?: string; input?: unknown; errorText?: string };
                    const { icon, done } = toolStatus(p.state);
                    return (
                      <details key={i} className="mt-1 rounded bg-black/5 p-1 text-xs dark:bg-white/10">
                        <summary className="cursor-pointer">{icon} {toolLabel(p.type, p.input)}{done === 'error' && p.errorText ? ` — ${p.errorText}` : ''}</summary>
                        <pre className="mt-1 overflow-x-auto">{JSON.stringify(p.input ?? {}, null, 1)}</pre>
                      </details>
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          ))}
          {busy && <p className="text-sm text-neutral-400">…thinking</p>}
        </div>

        {/* Follow-up suggestion chips — click to ask next. */}
        {followupsOn && followups.length > 0 && !busy && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {followups.map((q, i) => (
              <button key={i} onClick={() => { send(q); }}
                className="rounded-full border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 hover:border-blue-500 hover:text-blue-600 dark:border-neutral-700 dark:text-neutral-300">
                {q}
              </button>
            ))}
          </div>
        )}

        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!input.trim() || busy) return;
            send(input, investigate ? 'investigate' : 'chat');
            setInput('');
          }}
        >
          <label className="flex items-center gap-1 text-xs text-neutral-500" title="Deeper multi-step analysis (plan → drill-down → evidence)">
            <input type="checkbox" checked={investigate} onChange={(e) => setInvestigate(e.target.checked)} />
            Investigate
          </label>
          <input
            className="flex-1 rounded border p-2 dark:bg-neutral-900"
            placeholder={investigate ? 'e.g. Why did activity drop in Q2?' : 'e.g. How many rows in the largest table?'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" disabled={busy} className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">Send</button>
        </form>
      </div>

      {/* Workspace column (lg+). One instance — the tab strip hides itself at 2xl
          when the session rail takes over, so block state survives breakpoint changes. */}
      <div className="hidden h-full min-h-0 lg:block">
        <ChatWorkspacePanel artifacts={artifacts} selected={selected} onSelect={selectArtifact} unseen={unseen}
          connectionId={connectionId} dialect={dialect} sessionId={sessionId} busy={busy} onAnalyzeDeeper={analyzeDeeper} />
      </div>

      {/* Session rail (2xl only). */}
      <div className="hidden h-full min-h-0 2xl:block">
        <ChatSessionRail artifacts={artifacts} selected={selected} onSelect={selectArtifact} unseen={unseen} />
      </div>
    </main>
  );
}

/** Human-readable label for a generic tool step. run_sql / plan_analysis /
 *  ask_user are handled by their own branches and never reach here. */
function toolLabel(type: string, input: unknown): string {
  const name = type.replace('tool-', '');
  const inp = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'schema_details': return 'Reading the schema';
    case 'sample_rows': return `Sampling rows${inp.table ? ` from ${inp.table}` : ''}`;
    case 'glossary_lookup': return `Looking up${inp.term ? ` "${inp.term}"` : ' a term'}`;
    case 'query_history_search': return 'Searching verified queries';
    case 'profile_column': return `Profiling${inp.table && inp.column ? ` ${inp.table}.${inp.column}` : ' a column'}`;
    case 'detect_anomalies': return `Checking${inp.table && inp.column ? ` ${inp.table}.${inp.column}` : ''} for anomalies`;
    default: return name.replace(/_/g, ' ');
  }
}

/** Map an AI SDK v7 tool-part state to an icon + terminal kind. output-error must
 *  NOT stay at ⏳ forever. */
function toolStatus(state?: string): { icon: string; done: 'ok' | 'error' | 'running' } {
  if (state === 'output-available') return { icon: '✓', done: 'ok' };
  if (state === 'output-error') return { icon: '✗', done: 'error' };
  return { icon: '⏳', done: 'running' };
}

/** Inline clarifying-question box for the ask_user tool (red-team C1). */
function AskUserBox({ question, options, onAnswer, disabled }: { question: string; options?: string[]; onAnswer: (a: string) => void; disabled: boolean }) {
  const [val, setVal] = useState('');
  return (
    <div className="mt-1 rounded border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950">
      <div className="mb-1 font-medium">❓ {question}</div>
      {options && options.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {options.map((o, i) => (
            <button key={i} disabled={disabled} onClick={() => onAnswer(o)} className="rounded border border-amber-400 px-2 py-0.5 hover:bg-amber-100 disabled:opacity-50 dark:hover:bg-amber-900">{o}</button>
          ))}
        </div>
      )}
      <div className="flex gap-1">
        <input className="flex-1 rounded border p-1 dark:bg-neutral-900" value={val} onChange={(e) => setVal(e.target.value)} placeholder="Type your answer…" />
        <button disabled={disabled || !val.trim()} onClick={() => onAnswer(val)} className="rounded bg-amber-600 px-2 py-1 text-white disabled:opacity-50">Answer</button>
      </div>
    </div>
  );
}
