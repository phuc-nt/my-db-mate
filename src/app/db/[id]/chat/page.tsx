'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { use, useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { QueryResultBlock } from '../../../../components/query-result-block';
import { ChatArtifactChip, type ChatArtifact } from '../../../../components/chat-artifact-chip';
import { ChatWorkspacePanel, ChatSessionRail } from '../../../../components/chat-workspace-panel';
import { FormModal } from '../../../../components/form-modal';
import { ContextProvenanceBadge, type Provenance } from '../../../../components/context-provenance-badge';
import { InboxPopover } from '../../../../components/inbox-popover';
import { pruneDanglingToolCalls, userTurnBefore, extractUserText, summarizeToolParts, type UIMsg, type UIPart } from '../../../../lib/chat-interrupt-helpers';

/** Shape of a streamed run_sql tool part (subset we read). */
interface RunSqlPart {
  state?: string;
  toolCallId: string;
  input?: { sql?: string };
  output?: { columns?: string[]; rows?: unknown[][]; executedSql?: string; blocked?: boolean; reason?: string; error?: string; note?: string; lineage?: { tables: string[]; whereColumns: string[]; groupBy: string[] } | null; accelerated?: { asOf: string; skewWarning?: { spreadMs: number } }; verifyChecks?: { id: string; status: 'pass' | 'warn' | 'skip'; note?: string }[] };
}

export default function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: connectionId } = use(params);
  const [input, setInput] = useState('');
  const router = useRouter();
  // Deep-link prefill (?q=…): fill the input ONCE on mount, never auto-send, and
  // strip the param so a reload doesn't re-fill over what the user typed since.
  // window.location (not useSearchParams) keeps this client page Suspense-free.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q');
    if (!q) return;
    setInput(q);
    router.replace(`/db/${connectionId}/chat`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [investigate, setInvestigate] = useState(false);
  const [deep, setDeep] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const [distillMsg, setDistillMsg] = useState('');
  const [dialect, setDialect] = useState<'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'duckdb'>();

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

  // Knowledge-Inbox nudge (M2): after a completed turn, surface pending
  // suggestions as a one-per-session chip near the input.
  const [inboxCount, setInboxCount] = useState(0);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const provenanceMsgIdRef = useRef<string | null>(null);
  const [inboxChipDismissed, setInboxChipDismissed] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const inboxMsgIdRef = useRef<string | null>(null);

  // Follow-up question suggestions after a completed turn.
  const [followups, setFollowups] = useState<string[]>([]);
  const [followupsOn, setFollowupsOn] = useState(true);
  const followupMsgIdRef = useRef<string | null>(null); // dedupe: one fetch per assistant turn
  const followupAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    setFollowupsOn(localStorage.getItem('mdm.followups') !== 'off');
  }, []);

  // Investigate-from-finding autostart: kickoff text fetched from the session's
  // server-side target (never client-carried), fired once when the chat is ready.
  const [pendingKickoff, setPendingKickoff] = useState<string | null>(null);
  const kickoffFiredRef = useRef(false);

  // Create a session for this chat so queries + transcript can be distilled later.
  // `?session=<id>` (investigate-from-finding, navigate-first flow) reuses the
  // session the investigate-finding route created instead of minting a new one —
  // THIS page owns the stream, so navigating here first means the conclusion's
  // onFinish persistence can't be lost to an aborted fetch elsewhere.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const existing = sp.get('session');
    if (existing) {
      setSessionId(existing);
      if (sp.get('autostart')) {
        fetch(`/api/connections/${connectionId}/investigate-finding?sessionId=${existing}`)
          .then((r) => r.json())
          .then((d) => { if (d.kickoff) setPendingKickoff(d.kickoff); })
          .catch(() => {});
      }
      router.replace(`/db/${connectionId}/chat`, { scroll: false });
    } else {
      fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connectionId }) })
        .then((r) => r.json()).then((s) => setSessionId(s.id));
    }
    // Dialect drives dialect-aware SQL-insert export in result blocks.
    fetch(`/api/connections/${connectionId}/schema`).then((r) => r.json()).then((d) => setDialect(d.dialect)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  // The assistant message the user interrupted with Stop (keyed by message id),
  // set from onFinish's authoritative isAbort flag — NOT from `status`, which is
  // 'ready' on both a natural finish and an abort.
  const [interruptedMsgId, setInterruptedMsgId] = useState<string | null>(null);
  const { messages, sendMessage, addToolResult, status, setMessages, stop } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      body: { connectionId, sessionId },
    }),
    // When the model calls ask_user (a no-execute tool), the stream stops at that
    // tool-call; we render the question and resume via addToolResult below.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onFinish: ({ message, isAbort }) => {
      // Authoritative interrupt signal: mark the aborted turn so the UI can offer
      // keep/edit/discard; a genuine finish clears any stale flag for that id.
      setInterruptedMsgId((cur) => (isAbort ? message.id : cur === message.id ? null : cur));
    },
  });

  const busy = status === 'submitted' || status === 'streaming';

  // The workspace artifacts ARE the run_sql parts of the transcript — derived,
  // never duplicated into separate state.
  const artifacts = useMemo<ChatArtifact[]>(() => {
    const list: ChatArtifact[] = [];
    let lastUserText = '';
    for (const m of messages) {
      if (m.role === 'user') {
        lastUserText = m.parts.filter((pt) => pt.type === 'text').map((pt) => (pt as { text: string }).text).join(' ');
      }
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
          question: lastUserText || undefined,
          lineage: p.output?.lineage ?? null,
          accelerated: p.output?.accelerated,
          verifyChecks: p.output?.verifyChecks,
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

  // M2: refresh the pending-suggestions count once per completed turn.
  useEffect(() => {
    if (status !== 'ready') return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const lastPart = last.parts[last.parts.length - 1];
    if (lastPart?.type !== 'text') return;
    if (inboxMsgIdRef.current === last.id) return;
    inboxMsgIdRef.current = last.id;
    fetch(`/api/connections/${connectionId}/suggestions`)
      .then((r) => r.json())
      .then((d) => setInboxCount(Array.isArray(d) ? d.length : 0))
      .catch(() => {});
  }, [status, messages, connectionId]);

  // Provenance/confidence badge (P2): once per completed turn, ask which curated
  // context plausibly grounded the answer. Names only, no extra LLM call.
  useEffect(() => {
    if (status !== 'ready') return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const lastPart = last.parts[last.parts.length - 1];
    if (lastPart?.type !== 'text') return;
    if (provenanceMsgIdRef.current === last.id) return;
    provenanceMsgIdRef.current = last.id;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const question = lastUser?.parts.filter((pt) => pt.type === 'text').map((pt) => (pt as { text: string }).text).join(' ') ?? '';
    if (!question) return;
    const sqlTexts = artifacts.map((a) => a.executedSql ?? a.sql).filter(Boolean);
    fetch(`/api/connections/${connectionId}/context-used`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, sqlTexts }),
    }).then((r) => r.json()).then(setProvenance).catch(() => {});
  }, [status, messages, connectionId, artifacts]);

  // True once an investigate-from-finding session started here — used to guard
  // against navigating away mid-run.
  const [isInvestigationSession, setIsInvestigationSession] = useState(false);

  // Fire the investigation kickoff exactly once, after the session id is bound.
  // Mode is advisory here — the chat route forces investigate mode + the 5-step
  // cap for any session that carries an investigation target.
  useEffect(() => {
    if (!pendingKickoff || !sessionId || kickoffFiredRef.current) return;
    kickoffFiredRef.current = true;
    setIsInvestigationSession(true);
    send(pendingKickoff, 'investigate');
    setPendingKickoff(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKickoff, sessionId]);

  // Warn before leaving while an investigation is still streaming. Persistence of
  // the conclusion is only guaranteed while the client stays connected (the
  // server's background drain can be cancelled on a hard disconnect under the
  // dev/serverless request lifecycle), so keep the user here until it finishes.
  useEffect(() => {
    if (!(isInvestigationSession && busy)) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isInvestigationSession, busy]);

  // The mode of the in-flight turn — Discard needs it: an investigate turn was
  // drained server-side (persisted) so it needs a server delete; a chat turn was
  // truly aborted (never persisted) so client removal is enough.
  const lastSentModeRef = useRef<'chat' | 'investigate' | 'investigate-deep'>('chat');

  /** Send a turn, optionally in investigate mode (deeper multi-step analysis). */
  function send(text: string, mode: 'chat' | 'investigate' | 'investigate-deep' = 'chat') {
    // Clear + abort any pending follow-up fetch so stale chips don't repopulate
    // the turn the user just moved past (covers typed sends AND chip clicks).
    setFollowups([]);
    setProvenance(null);
    followupAbortRef.current?.abort();
    setFollowLatest(true);
    lastSentModeRef.current = mode;
    sendMessage({ text }, { body: { connectionId, sessionId, mode } });
  }

  /** Keep the interrupted partial as the answer — just clear the interrupt flag,
   *  pruning the dangling tool-call so the NEXT send doesn't throw. */
  function keepInterrupted(msgId: string) {
    setMessages((ms) => ms.map((m) => (m.id === msgId ? (pruneDanglingToolCalls(m as UIMsg) as typeof m) : m)));
    setInterruptedMsgId(null);
  }

  /** Edit & resend: prefill the input with the original question, drop the
   *  interrupted assistant turn, and let the user edit + press Send (no auto-send). */
  function editResendInterrupted(msgId: string) {
    const prior = userTurnBefore(messages as UIMsg[], msgId);
    setInput(extractUserText(prior));
    setMessages((ms) => ms.filter((m) => m.id !== msgId));
    setInterruptedMsgId(null);
  }

  /** Discard the interrupted turn. Chat turns were never persisted (truly
   *  aborted) so client removal suffices; investigate turns were drained + saved
   *  server-side, so also delete the persisted assistant message. */
  async function discardInterrupted(msgId: string) {
    setMessages((ms) => ms.filter((m) => m.id !== msgId));
    setInterruptedMsgId(null);
    if (lastSentModeRef.current !== 'chat' && sessionId) {
      await fetch(`/api/chat/sessions/${sessionId}/last-assistant`, { method: 'DELETE' }).catch(() => {});
    }
  }

  function toggleFollowups() {
    setFollowupsOn((on) => {
      const next = !on;
      localStorage.setItem('mdm.followups', next ? 'on' : 'off');
      // Off clears the chips; re-enabling resets the dedupe ref so the fetch
      // effect can regenerate suggestions for the already-completed turn.
      if (!next) setFollowups([]);
      else followupMsgIdRef.current = null;
      return next;
    });
  }

  /** A "Confirm & run anyway" happened in the SQL panel — the agent never sees
   *  manual executions, so append a compact user message with the result to the
   *  transcript. Local-only (setMessages): no request fires until the next turn,
   *  which then carries this context to the model. Rows are capped to keep the
   *  transcript small; exposure equals a normal run_sql output. */
  function recordConfirmedRun(label: string, info: { sql: string; columns: string[]; rows: unknown[][] }) {
    const head = info.rows.slice(0, 10)
      .map((r) => r.map((c) => String(c ?? 'null').slice(0, 60)).join(' | ')).join('\n');
    const more = info.rows.length > 10 ? `\n… (${info.rows.length - 10} more rows)` : '';
    const text = `[I pressed "Confirm & run anyway" on ${label} — it has now executed]\nSQL: ${info.sql}\n${info.rows.length} rows. Columns: ${info.columns.join(', ')}\n${head}${more}`;
    setMessages((msgs) => [...msgs, {
      id: `manual-run-${label}-${Date.now()}`,
      role: 'user' as const,
      parts: [{ type: 'text' as const, text }],
    }]);
  }

  const analyzeDeeper = (sql: string) =>
    send(`Analyze this result more deeply — trends, comparisons, and anomalies. The query was: ${sql}`, 'investigate');

  const okRunCount = artifacts.filter((a) => a.columns && !a.blocked && !a.error).length;
  const [distilledThisSession, setDistilledThisSession] = useState(false);
  // M3: after 3 successful queries, the quiet header button grows a dot + count so
  // the "teach the context layer" loop is visible right when there is material.
  const distillHot = okRunCount >= 3 && !distilledThisSession;

  async function distill() {
    setDistilledThisSession(true);
    if (!sessionId) return;
    setDistillMsg('Distilling…');
    const r = await fetch(`/api/sessions/${sessionId}/distill`, { method: 'POST' });
    const d = await r.json();
    setDistillMsg(d.created != null ? `${d.created} suggestion(s) added to Context Studio inbox` : `error: ${d.error}`);
  }

  const [notebookModal, setNotebookModal] = useState(false);
  async function saveNotebook(title: string) {
    if (!sessionId || !title) return;
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
    // --workspace-chrome-h is set by the /db/[id] layout (global nav + workspace bar).
    <main className="mx-auto h-[calc(100dvh-var(--workspace-chrome-h,3rem))] max-w-4xl p-4 lg:grid lg:max-w-none lg:grid-cols-[minmax(340px,2fr)_3fr] lg:gap-4 2xl:grid-cols-[minmax(360px,1fr)_2fr_230px]">
      <div className="flex h-full min-h-0 flex-col">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-lg font-semibold">Chat</h1>
          <div className="flex items-center gap-3 text-sm">
            {distillMsg && <span className="text-xs text-neutral-500">{distillMsg}</span>}
            <button onClick={toggleFollowups} className={followupsOn ? 'text-blue-600' : 'text-neutral-400'} title="Suggest follow-up questions after each answer">Follow-ups {followupsOn ? 'on' : 'off'}</button>
            <button onClick={() => setNotebookModal(true)} disabled={!sessionId || messages.length === 0} className="text-blue-600 disabled:opacity-40">Save as notebook</button>
            <button onClick={distill} disabled={!sessionId || messages.length === 0}
              className={distillHot ? 'font-medium text-blue-600' : 'text-blue-600 disabled:opacity-40'}>
              {distillHot ? `● Distill what we learned (${okRunCount})` : 'Distill to context'}</button>
            <Link href={`/db/${connectionId}/schema`} className="text-blue-600">Browse</Link>
            <Link href={`/db/${connectionId}/context`} className="text-blue-600">Context</Link>
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
                {m.role === 'assistant' && <ChatPlanCard parts={m.parts as unknown as UIPart[]} />}
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
                            initialResult={ok ? { columns: out!.columns!, rows: out!.rows ?? [], executedSql: out!.executedSql, lineage: out!.lineage, accelerated: out!.accelerated, verifyChecks: out!.verifyChecks } : undefined}
                            initialBlockedReason={out?.blocked ? out.reason : undefined}
                            initialError={out?.error}
                            onConfirmedRun={(info) => recordConfirmedRun(`Q${artifact?.index ?? '?'}`, info)}
                            question={artifact?.question}
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
                {m.id === interruptedMsgId && (
                  <div className="mt-2 border-t border-amber-300 pt-2 text-xs dark:border-amber-800" data-testid="interrupt-actions">
                    <span className="text-amber-600">⏹ Interrupted — </span>
                    <button onClick={() => keepInterrupted(m.id)} data-testid="interrupt-keep" className="mx-1 underline hover:text-blue-600">Keep</button>
                    <button onClick={() => editResendInterrupted(m.id)} data-testid="interrupt-edit" className="mx-1 underline hover:text-blue-600">Edit &amp; resend</button>
                    <button onClick={() => discardInterrupted(m.id)} data-testid="interrupt-discard" className="mx-1 underline hover:text-red-600">Discard</button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {busy && <p className="text-sm text-neutral-400">…thinking</p>}
        </div>

        {/* Follow-up suggestion chips — click to ask next. */}
        {provenance && !busy && <ContextProvenanceBadge p={provenance} connectionId={connectionId} />}
        {inboxOpen && <InboxPopover connectionId={connectionId} onClose={() => setInboxOpen(false)} onChanged={(n) => { setInboxCount(n); if (n === 0) setInboxOpen(false); }} />}
        {inboxCount > 0 && !inboxChipDismissed && !busy && !inboxOpen && (
          <div className="mb-1 flex items-center gap-2 text-xs" data-testid="inbox-chip">
            <button onClick={() => setInboxOpen(true)} className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800 hover:border-amber-500 dark:bg-amber-950/40 dark:text-amber-300">
              💡 {inboxCount} context suggestion{inboxCount === 1 ? '' : 's'} — review here →
            </button>
            <button onClick={() => setInboxChipDismissed(true)} className="text-neutral-400 hover:text-neutral-600" title="Dismiss">✕</button>
          </div>
        )}
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
            send(input, investigate ? (deep ? 'investigate-deep' : 'investigate') : 'chat');
            setInput('');
          }}
        >
          <label className="flex items-center gap-1 text-xs text-neutral-500" title="Deeper multi-step analysis (plan → drill-down → evidence)">
            <input type="checkbox" checked={investigate} onChange={(e) => setInvestigate(e.target.checked)} />
            Investigate
          </label>
          {investigate && (
            <label className="flex items-center gap-1 text-xs text-neutral-500" title="Gấp đôi budget bước/query (~2x cost) cho câu hỏi thật khó" data-testid="deep-toggle">
              <input type="checkbox" checked={deep} onChange={(e) => setDeep(e.target.checked)} />
              Deep <span className="text-[10px] text-amber-600">~2x</span>
            </label>
          )}
          <input
            className="flex-1 rounded border p-2 dark:bg-neutral-900"
            placeholder={investigate ? 'e.g. Why did activity drop in Q2?' : 'e.g. How many rows in the largest table?'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          {busy ? (
            <button type="button" onClick={() => stop()} data-testid="chat-stop"
              className="rounded border border-red-300 px-4 py-2 text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/30"
              title={lastSentModeRef.current === 'chat' ? 'Stop — halts the query' : 'Stop showing (the investigation finishes in the background)'}>
              ⏹ Stop
            </button>
          ) : (
            <button type="submit" className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">Send</button>
          )}
        </form>
        {isInvestigationSession && busy && (
          <p className="mt-1 text-center text-[11px] text-amber-600" data-testid="investigation-running-notice">
            🔎 Investigation running — stay on this page until it finishes so the conclusion is saved.
          </p>
        )}
      </div>

      {/* Workspace column (lg+). One instance — the tab strip hides itself at 2xl
          when the session rail takes over, so block state survives breakpoint changes. */}
      <div className="hidden h-full min-h-0 lg:block">
        <ChatWorkspacePanel artifacts={artifacts} selected={selected} onSelect={selectArtifact} unseen={unseen} onConfirmedRun={recordConfirmedRun}
          connectionId={connectionId} dialect={dialect} sessionId={sessionId} busy={busy} onAnalyzeDeeper={analyzeDeeper} />
      </div>

      {/* Session rail (2xl only). */}
      <div className="hidden h-full min-h-0 2xl:block">
        <ChatSessionRail artifacts={artifacts} selected={selected} onSelect={selectArtifact} unseen={unseen} />
      </div>
          <FormModal open={notebookModal} title="Save session as notebook" submitLabel="Save"
        fields={[{ name: 'title', label: 'Notebook title', defaultValue: 'Analysis notebook', required: true }]}
        onSubmit={(v) => { setNotebookModal(false); saveNotebook(v.title.trim()); }} onClose={() => setNotebookModal(false)} />
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

/** Chat-mode plan card: a live checklist derived from the assistant turn's
 *  tool-call parts (no extra LLM call). Only shown for genuine multi-step turns
 *  (≥2 tool-calls) so a one-shot answer stays uncluttered. A step in flight is
 *  dimmed with a spinner; a completed step shows ✓; an errored step shows ✗.
 *  Separate surface from the investigate-only 📋 plan_analysis card. */
function ChatPlanCard({ parts }: { parts: UIPart[] }) {
  // Investigate turns already render the dedicated "📋 Analysis plan" card
  // (the plan_analysis tool). Suppress this chat-mode Steps card there so the
  // two 📋 surfaces never stack in one bubble — this stays a distinct surface.
  if (parts.some((p) => p.type === 'tool-plan_analysis')) return null;
  const steps = summarizeToolParts(parts);
  if (steps.length < 2) return null;
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <details open className="mb-1 rounded border border-blue-200 bg-blue-50 p-2 text-xs dark:border-blue-900 dark:bg-blue-950" data-testid="chat-plan-card">
      <summary className="cursor-pointer font-medium">📋 Steps ({doneCount}/{steps.length})</summary>
      <ol className="mt-1 space-y-0.5 pl-1">
        {steps.map((s, j) => (
          <li key={j} className={s.done || s.errored ? '' : 'text-neutral-400'}>
            {s.errored ? '✗' : s.done ? '✓' : '⏳'} {s.label}
          </li>
        ))}
      </ol>
    </details>
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
