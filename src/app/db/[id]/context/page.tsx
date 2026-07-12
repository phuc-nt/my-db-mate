'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

type Tab = 'glossary' | 'annotations' | 'relationships' | 'verified' | 'inbox' | 'coverage';

interface ContextData {
  tables: { id: string; tableName: string; description: string | null; businessAlias: string | null; isDeprecated: boolean }[];
  columns: { id: string; tableName: string; columnName: string; description: string | null; isSensitive: boolean }[];
  glossary: { id: string; term: string; definition: string; sqlMapping: string | null; synonyms: string[] | null }[];
  relationships: { id: string; fromTable: string; fromColumn: string; toTable: string; toColumn: string }[];
  verified: { id: string; question: string; sql: string; isDisabled: boolean }[];
}
interface Suggestion { id: string; kind: string; payload: Record<string, unknown>; reason: string | null }

export default function ContextStudio({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tab, setTab] = useState<Tab>('glossary');
  const [data, setData] = useState<ContextData | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    fetch(`/api/connections/${id}/context`).then((r) => r.json()).then(setData);
    fetch(`/api/connections/${id}/suggestions`).then((r) => r.json()).then(setSuggestions);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch(`/api/connections/${id}/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) { setMsg('saved'); load(); } else setMsg('error: ' + (await r.json()).error);
  };

  const suggestionAction = async (suggestionId: string, action: 'accept' | 'reject') => {
    await fetch(`/api/connections/${id}/suggestions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, suggestionId }) });
    load();
  };

  const [suggesting, setSuggesting] = useState(false);
  async function suggestEnums() {
    setSuggesting(true); setMsg('Scanning columns for enum candidates…');
    // No LLM drafts by default (fast; the P5b spike showed draft hints add little
    // and the human supplies the meaning anyway). Draft is an opt-in follow-up.
    const r = await fetch(`/api/connections/${id}/suggest-enums`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ withDrafts: false }) });
    const d = await r.json();
    setMsg(d.error ? `error: ${d.error}` : `Scanned ${d.scanned} columns → ${d.created} enum suggestion(s) in the Inbox`);
    setSuggesting(false); load(); setTab('inbox');
  }
  const [mining, setMining] = useState(false);
  const [pasteLog, setPasteLog] = useState<string | null>(null); // non-null → show paste box
  async function mineHistory(pastedLog?: string) {
    setMining(true); setMsg('Mining query history…');
    const r = await fetch(`/api/connections/${id}/mine-history`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pastedLog ? { pastedLog } : {}),
    });
    const d = await r.json();
    setMining(false);
    if (d.error) { setMsg(`error: ${d.error}`); return; }
    if (!d.available) { setMsg(d.hint ?? 'Query history not available — paste a log below.'); setPasteLog(''); return; }
    const extra = d.hint ? ` — ${d.hint}` : d.skipped ? ` (${d.skipped} skipped)` : '';
    setMsg(`Mined ${d.source}: ${d.created} suggestion(s) in the Inbox${extra}`);
    setPasteLog(null); load(); setTab('inbox');
  }
  const [discovering, setDiscovering] = useState(false);
  async function runDiscovery() {
    setDiscovering(true); setMsg('Discovering table descriptions + relationships…');
    const r = await fetch(`/api/connections/${id}/discovery`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const d = await r.json();
    setMsg(d.error ? `error: ${d.error}` : `Discovery: ${d.tablesScanned} tables → ${d.suggestionsCreated} suggestion(s) in the Inbox`);
    setDiscovering(false); load(); setTab('inbox');
  }
  async function importGlossary(file: File) {
    setMsg('Importing glossary…');
    const text = await file.text();
    const r = await fetch(`/api/connections/${id}/import-glossary`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, sourceName: file.name }) });
    const d = await r.json();
    setMsg(d.error ? `error: ${d.error}` : `Imported ${d.parsed} terms from ${file.name} → ${d.created} suggestion(s) in the Inbox`);
    load(); setTab('inbox');
  }

  async function exportYaml() {
    const r = await fetch(`/api/connections/${id}/context/yaml`);
    const text = await r.text();
    const blob = new Blob([text], { type: 'text/yaml' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'context.yaml'; a.click();
  }

  const tabs: Tab[] = ['glossary', 'annotations', 'relationships', 'verified', 'inbox', 'coverage'];

  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Context Studio</h1>
        <div className="flex gap-3 text-sm">
          <button onClick={() => mineHistory()} disabled={mining} className="text-blue-600 disabled:opacity-50">{mining ? 'Mining…' : 'Mine query history'}</button>
          <button onClick={runDiscovery} disabled={discovering} className="text-blue-600 disabled:opacity-50">{discovering ? 'Discovering…' : 'Run discovery'}</button>
          <button onClick={suggestEnums} disabled={suggesting} className="text-blue-600 disabled:opacity-50">{suggesting ? 'Scanning…' : 'Suggest enum annotations'}</button>
          <label className="cursor-pointer text-blue-600">
            Import glossary
            <input type="file" accept=".csv,.md,.txt" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importGlossary(f); e.target.value = ''; }} />
          </label>
          <button onClick={exportYaml} className="text-blue-600">Export YAML</button>
          <Link href={`/db/${id}/chat`} className="text-blue-600">Chat →</Link>
          <Link href="/connections" className="text-neutral-500">Connections</Link>
        </div>
      </div>

      <div className="mb-4 flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm ${tab === t ? 'border-b-2 border-blue-600 font-medium' : 'text-neutral-500'}`}>
            {t}{t === 'inbox' && suggestions.length > 0 ? ` (${suggestions.length})` : ''}
          </button>
        ))}
        <Link href={`/db/${id}/context/eval`} className="px-3 py-2 text-sm text-neutral-500 hover:text-blue-600">eval</Link>
      </div>
      {msg && <p className="mb-2 text-xs text-neutral-500">{msg}</p>}

      {pasteLog !== null && (
        <div className="mb-4 rounded border border-neutral-200 p-3 dark:border-neutral-800">
          <div className="mb-1 text-xs font-medium">Paste a query log or .sql file</div>
          <textarea className="w-full rounded border p-2 font-mono text-xs dark:bg-neutral-900" rows={6}
            placeholder="SELECT ... ;&#10;SELECT ... ;" value={pasteLog} onChange={(e) => setPasteLog(e.target.value)} />
          <div className="mt-1 flex gap-2">
            <button onClick={() => mineHistory(pasteLog)} disabled={mining || !pasteLog.trim()} className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50">Mine pasted log</button>
            <button onClick={() => setPasteLog(null)} className="rounded border px-3 py-1 text-xs">Cancel</button>
          </div>
        </div>
      )}

      {tab === 'glossary' && <GlossaryTab data={data} onAdd={(b) => post({ type: 'glossary', ...b })} />}
      {tab === 'annotations' && <AnnotationsTab data={data} onAdd={(b) => post(b)} />}
      {tab === 'relationships' && <RelationshipsTab data={data} onAdd={(b) => post({ type: 'relationship', ...b })} />}
      {tab === 'verified' && <VerifiedTab connectionId={id} data={data} onToggle={(queryId, disabled) => post({ type: 'verified_query_disable', queryId, disabled })} />}
      {tab === 'inbox' && <InboxTab suggestions={suggestions} onAction={suggestionAction} />}
      {tab === 'coverage' && <CoverageTab data={data} />}
    </main>
  );
}

function GlossaryTab({ data, onAdd }: { data: ContextData | null; onAdd: (b: Record<string, unknown>) => void }) {
  const [f, setF] = useState({ term: '', definition: '', sqlMapping: '' });
  return (
    <div>
      <div className="mb-3 grid grid-cols-3 gap-2">
        <input className="rounded border p-2 dark:bg-neutral-900" placeholder="Term (business)" value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })} />
        <input className="rounded border p-2 dark:bg-neutral-900" placeholder="Definition" value={f.definition} onChange={(e) => setF({ ...f, definition: e.target.value })} />
        <input className="rounded border p-2 dark:bg-neutral-900" placeholder="SQL mapping (optional)" value={f.sqlMapping} onChange={(e) => setF({ ...f, sqlMapping: e.target.value })} />
      </div>
      <button onClick={() => { onAdd(f); setF({ term: '', definition: '', sqlMapping: '' }); }} disabled={!f.term || !f.definition} className="mb-4 rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50">Add term</button>
      <ul className="space-y-2 text-sm">
        {data?.glossary.map((g) => (
          <li key={g.id} className="rounded border border-neutral-200 p-2 dark:border-neutral-800">
            <b>{g.term}</b>: {g.definition} {g.sqlMapping && <code className="text-xs text-neutral-500">[{g.sqlMapping}]</code>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AnnotationsTab({ data, onAdd }: { data: ContextData | null; onAdd: (b: Record<string, unknown>) => void }) {
  const [f, setF] = useState({ tableName: '', description: '', businessAlias: '' });
  return (
    <div>
      <div className="mb-3 grid grid-cols-3 gap-2">
        <input className="rounded border p-2 dark:bg-neutral-900" placeholder="Table name" value={f.tableName} onChange={(e) => setF({ ...f, tableName: e.target.value })} />
        <input className="rounded border p-2 dark:bg-neutral-900" placeholder="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <input className="rounded border p-2 dark:bg-neutral-900" placeholder="Business alias" value={f.businessAlias} onChange={(e) => setF({ ...f, businessAlias: e.target.value })} />
      </div>
      <button onClick={() => { onAdd({ type: 'table_annotation', ...f }); setF({ tableName: '', description: '', businessAlias: '' }); }} disabled={!f.tableName} className="mb-4 rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50">Annotate table</button>
      <ul className="space-y-1 text-sm">
        {data?.tables.map((t) => (
          <li key={t.id} className="rounded border border-neutral-200 p-2 dark:border-neutral-800"><b>{t.tableName}</b>{t.businessAlias && ` (${t.businessAlias})`}: {t.description}</li>
        ))}
      </ul>
    </div>
  );
}

function RelationshipsTab({ data, onAdd }: { data: ContextData | null; onAdd: (b: Record<string, unknown>) => void }) {
  const [f, setF] = useState({ fromTable: '', fromColumn: '', toTable: '', toColumn: '' });
  return (
    <div>
      <div className="mb-3 grid grid-cols-4 gap-2">
        {(['fromTable', 'fromColumn', 'toTable', 'toColumn'] as const).map((k) => (
          <input key={k} className="rounded border p-2 dark:bg-neutral-900" placeholder={k} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
        ))}
      </div>
      <button onClick={() => { onAdd(f); setF({ fromTable: '', fromColumn: '', toTable: '', toColumn: '' }); }} disabled={!f.fromTable || !f.toTable} className="mb-4 rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50">Add relationship</button>
      <ul className="space-y-1 text-sm">
        {data?.relationships.map((r) => <li key={r.id} className="text-neutral-600 dark:text-neutral-400">{r.fromTable}.{r.fromColumn} → {r.toTable}.{r.toColumn}</li>)}
      </ul>
    </div>
  );
}

function VerifiedTab({ connectionId, data, onToggle }: { connectionId: string; data: ContextData | null; onToggle: (id: string, disabled: boolean) => void }) {
  // Per-item outcome of "Track as metric" — the server shape-validates the SQL,
  // so non-(time, value) queries fail here with the server's reason.
  const [trackMsg, setTrackMsg] = useState<Record<string, string>>({});
  async function track(v: { id: string; question: string; sql: string }) {
    const r = await fetch(`/api/connections/${connectionId}/metrics`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: v.question, sql: v.sql }),
    });
    const d = await r.json().catch(() => ({}));
    setTrackMsg((m) => ({ ...m, [v.id]: r.ok ? 'Tracking ✓ — see Metrics tab' : (d.error ?? 'failed') }));
  }
  return (
    <ul className="space-y-2 text-sm">
      {data?.verified.map((v) => (
        <li key={v.id} className={`rounded border border-neutral-200 p-2 dark:border-neutral-800 ${v.isDisabled ? 'opacity-40' : ''}`}>
          <div className="font-medium">{v.question}</div>
          <code className="text-xs text-neutral-500">{v.sql}</code>
          <button onClick={() => onToggle(v.id, !v.isDisabled)} className="ml-2 text-xs text-blue-600">{v.isDisabled ? 'enable' : 'disable'}</button>
          <button onClick={() => track(v)} className="ml-2 text-xs text-blue-600">📈 Track as metric</button>
          {trackMsg[v.id] && <span className="ml-2 text-xs text-neutral-500">{trackMsg[v.id]}</span>}
        </li>
      ))}
      {data?.verified.length === 0 && <li className="text-neutral-500">No verified queries yet. Save them from chat.</li>}
    </ul>
  );
}

function InboxTab({ suggestions, onAction }: { suggestions: Suggestion[]; onAction: (id: string, a: 'accept' | 'reject') => void }) {
  return (
    <ul className="space-y-2 text-sm">
      {suggestions.map((s) => (
        <li key={s.id} className="rounded border border-neutral-200 p-2 dark:border-neutral-800">
          <div className="text-xs text-neutral-500">{s.kind}</div>
          <SuggestionBody kind={s.kind} payload={s.payload} />
          {s.reason && <div className="text-xs italic text-neutral-500">{s.reason}</div>}
          <div className="mt-1 flex gap-2">
            <button onClick={() => onAction(s.id, 'accept')} className="rounded bg-green-600 px-2 py-0.5 text-xs text-white">Accept</button>
            <button onClick={() => onAction(s.id, 'reject')} className="rounded border px-2 py-0.5 text-xs">Reject</button>
          </div>
        </li>
      ))}
      {suggestions.length === 0 && <li className="text-neutral-500">Inbox empty. Distill a chat session or mine query history to generate suggestions.</li>}
    </ul>
  );
}

/** Render a suggestion payload legibly. A verified_query shows the generated
 *  question and the (parametrized) SQL side by side so the reviewer can catch an
 *  NL↔SQL mismatch before it enters the moat; a relationship shows the edge. */
function SuggestionBody({ kind, payload }: { kind: string; payload: Record<string, unknown> }) {
  if (kind === 'verified_query') {
    return (
      <div className="my-1 space-y-1">
        <div className="text-sm font-medium">{String(payload.question ?? '')}</div>
        <pre className="overflow-x-auto rounded bg-neutral-100 p-1 text-xs dark:bg-neutral-800">{String(payload.sql ?? '')}</pre>
      </div>
    );
  }
  if (kind === 'relationship') {
    return (
      <div className="my-1 font-mono text-xs">
        {String(payload.fromTable)}.{String(payload.fromColumn)} → {String(payload.toTable)}.{String(payload.toColumn)}
      </div>
    );
  }
  return <pre className="overflow-x-auto text-xs">{JSON.stringify(payload, null, 1)}</pre>;
}

function CoverageTab({ data }: { data: ContextData | null }) {
  if (!data) return null;
  const stats = [
    ['Tables annotated', data.tables.length],
    ['Columns annotated', data.columns.length],
    ['Glossary terms', data.glossary.length],
    ['Manual relationships', data.relationships.length],
    ['Verified queries', data.verified.filter((v) => !v.isDisabled).length],
  ] as const;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {stats.map(([label, n]) => (
        <div key={label} className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="text-2xl font-semibold">{n}</div>
          <div className="text-xs text-neutral-500">{label}</div>
        </div>
      ))}
    </div>
  );
}
