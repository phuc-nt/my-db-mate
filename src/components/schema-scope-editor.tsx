'use client';

import { useState } from 'react';

export interface SchemaScopeValue {
  datasets?: string[];
  tables?: string[];
  viewsOnly?: boolean;
}

interface ImpactedArtifact {
  kind: 'metric' | 'verified_query' | 'dashboard_widget' | 'schedule';
  id: string;
  name: string;
  offendingRefs: string[];
  unparseable: boolean;
  scheduled: boolean;
}

const KIND_LABEL: Record<ImpactedArtifact['kind'], string> = {
  metric: 'Metric',
  verified_query: 'Saved query',
  dashboard_widget: 'Widget',
  schedule: 'Schedule',
};

/** Shard families (`events_20260101`, `events_20260102`, …) would otherwise fill
 *  the picker with hundreds of near-identical rows. Collapse them to one entry
 *  whose grant covers the whole family, matching how the guard reads a wildcard. */
function collapseShards(names: string[]): { label: string; value: string; shards: number }[] {
  const families = new Map<string, string[]>();
  const singles: string[] = [];
  for (const n of names) {
    const m = /^(.*?)(\d{6,})$/.exec(n);
    if (m) {
      const key = `${m[1]}*`;
      families.set(key, [...(families.get(key) ?? []), n]);
    } else {
      singles.push(n);
    }
  }
  const out = singles.map((n) => ({ label: n, value: n, shards: 1 }));
  for (const [key, members] of families) {
    if (members.length === 1) out.push({ label: members[0], value: members[0], shards: 1 });
    else out.push({ label: key, value: key, shards: members.length });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Sets the governed boundary for a connection: which tables the agent may read.
 * Narrowing is a real decision with real casualties, so applying is a two-step
 * action — preview what breaks, then commit — rather than a toggle that silently
 * disables someone's nightly schedule.
 */
export function SchemaScopeEditor({
  connectionId,
  allTableNames,
  initialScope,
  onApplied,
}: {
  connectionId: string;
  allTableNames: string[];
  initialScope: SchemaScopeValue | null;
  onApplied?: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialScope?.tables ?? []));
  const [preview, setPreview] = useState<ImpactedArtifact[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const entries = collapseShards(allTableNames);
  const active = selected.size > 0;

  const toggle = (value: string) => {
    setPreview(null); setMsg('');
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  };

  const body = (dryRun: boolean) => JSON.stringify({
    dryRun,
    scope: active ? { tables: [...selected] } : null,
  });

  async function check() {
    setBusy(true); setMsg('');
    const r = await fetch(`/api/connections/${connectionId}/scope`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: body(true),
    });
    const d = await r.json();
    setPreview(d.impacted ?? []);
    setBusy(false);
  }

  async function apply() {
    setBusy(true);
    const r = await fetch(`/api/connections/${connectionId}/scope`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: body(false),
    });
    const d = await r.json();
    const paused = d.pausedScheduleIds?.length ?? 0;
    setMsg(
      active
        ? `Scope applied: ${selected.size} table${selected.size === 1 ? '' : 's'} in bounds.` +
          (d.evictedSnapshots ? ` ${d.evictedSnapshots} cached snapshot(s) evicted.` : '') +
          (paused ? ` ${paused} schedule(s) paused.` : '')
        : 'Scope cleared — the agent sees the full schema again.',
    );
    setPreview(null);
    setBusy(false);
    onApplied?.();
  }

  return (
    <div className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-semibold">Governed scope</h3>
        <span className={`rounded px-1.5 py-0.5 text-xs ${active ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'}`}>
          {active ? `${selected.size} in scope` : 'full schema'}
        </span>
      </div>
      <p className="mb-2 text-xs text-neutral-500">
        Pick the curated tables the agent may read. Everything else is refused at
        query time, not merely discouraged in the prompt. Leave empty for the full schema.
      </p>

      <ul className="mb-2 max-h-56 space-y-0.5 overflow-y-auto">
        {entries.map((e) => (
          <li key={e.value}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800">
              <input type="checkbox" checked={selected.has(e.value)} onChange={() => toggle(e.value)} />
              <span className="truncate font-mono text-xs">{e.label}</span>
              {e.shards > 1 && <span className="shrink-0 text-xs text-neutral-400">{e.shards} shards</span>}
            </label>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2">
        <button onClick={check} disabled={busy} className="rounded border px-3 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800">
          {busy ? 'Checking…' : 'Check impact'}
        </button>
        <button onClick={apply} disabled={busy} className="rounded bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
          Apply scope
        </button>
      </div>

      {preview !== null && (
        <div className="mt-2 text-xs">
          {preview.length === 0 ? (
            <p className="text-green-600">Nothing existing breaks under this scope.</p>
          ) : (
            <>
              <p className="mb-1 text-amber-600">
                {preview.length} existing item{preview.length === 1 ? '' : 's'} would be blocked.
                Schedules among them are paused on apply.
              </p>
              <ul className="space-y-0.5">
                {preview.map((a) => (
                  <li key={`${a.kind}-${a.id}`} className="text-neutral-600 dark:text-neutral-300">
                    <span className="text-neutral-400">{KIND_LABEL[a.kind]}:</span> {a.name}
                    {a.unparseable
                      ? ' — SQL could not be verified'
                      : ` — reads ${a.offendingRefs.join(', ')}`}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {msg && <p className="mt-2 text-xs text-green-600">{msg}</p>}
    </div>
  );
}
