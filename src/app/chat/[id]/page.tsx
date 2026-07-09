'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { use, useState, useEffect } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { QueryResultBlock } from '../../../components/query-result-block';

export default function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: connectionId } = use(params);
  const [input, setInput] = useState('');
  const [investigate, setInvestigate] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const [distillMsg, setDistillMsg] = useState('');
  const [dialect, setDialect] = useState<'postgres' | 'mysql' | 'sqlite'>();

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

  /** Send a turn, optionally in investigate mode (deeper multi-step analysis). */
  function send(text: string, mode: 'chat' | 'investigate' = 'chat') {
    sendMessage({ text }, { body: { connectionId, sessionId, mode } });
  }

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
    <main className="mx-auto flex h-screen max-w-4xl flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Chat</h1>
        <div className="flex items-center gap-3 text-sm">
          {distillMsg && <span className="text-xs text-neutral-500">{distillMsg}</span>}
          <button onClick={saveNotebook} disabled={!sessionId || messages.length === 0} className="text-blue-600 disabled:opacity-40">Save as notebook</button>
          <button onClick={distill} disabled={!sessionId || messages.length === 0} className="text-blue-600 disabled:opacity-40">Distill to context</button>
          <Link href={`/browse/${connectionId}`} className="text-blue-600">Browse</Link>
          <Link href={`/context-studio/${connectionId}`} className="text-blue-600">Context</Link>
          <Link href="/connections" className="text-blue-600">← Connections</Link>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        {messages.length === 0 && (
          <p className="text-sm text-neutral-500">Ask a question about your database. The assistant explores the schema and runs read-only SQL.</p>
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
                  const p = part as unknown as { state?: string; input?: { sql?: string }; output?: { columns?: string[]; rows?: unknown[][]; executedSql?: string; blocked?: boolean; reason?: string; error?: string } };
                  // While the tool input is still streaming, show a placeholder —
                  // only mount the (stateful) result block once we have the real SQL,
                  // so its initial SQL isn't frozen empty (browser-tested fix).
                  if (p.state !== 'output-available') {
                    return <div key={i} className="mt-1 text-xs text-neutral-400">⏳ running SQL…</div>;
                  }
                  const out = p.output;
                  const ok = out && !out.blocked && !out.error && out.columns;
                  return (
                    <div key={i}>
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
                        <button
                          onClick={() => send(`Analyze this result more deeply — trends, comparisons, and anomalies. The query was: ${out!.executedSql ?? p.input?.sql}`, 'investigate')}
                          className="mt-1 text-xs text-blue-600 hover:underline"
                        >🔎 Analyze deeper</button>
                      )}
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
                if (part.type.startsWith('tool-')) {
                  const p = part as unknown as { type: string; input?: unknown; output?: unknown };
                  return (
                    <details key={i} className="mt-1 rounded bg-black/5 p-1 text-xs dark:bg-white/10">
                      <summary className="cursor-pointer">🔧 {p.type.replace('tool-', '')}</summary>
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
    </main>
  );
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
