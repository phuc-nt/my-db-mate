'use client';

/**
 * Per-table incremental-refresh control for the schema browser (Phase 2 of
 * the OLAP accelerator deepening). Fetches a candidate watermark column
 * suggestion but never enables anything on its own — the user must press
 * Confirm (or type in a different column) before a config is written.
 */
import { useEffect, useState } from 'react';

interface Props {
  connectionId: string;
  tableName: string;
}

export function IncrementalRefreshControl({ connectionId, tableName }: Props) {
  const [config, setConfig] = useState<{ watermarkCol: string } | null | undefined>(undefined);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [draftColumn, setDraftColumn] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setConfig(undefined);
    setSuggestion(null);
    fetch(`/api/connections/${connectionId}/watermark-config?table=${encodeURIComponent(tableName)}`)
      .then((r) => r.json())
      .then((existing) => {
        setConfig(existing);
        if (existing) return;
        fetch(`/api/connections/${connectionId}/suggest-watermark`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ table: tableName }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (d.suggestedColumn) { setSuggestion(d.suggestedColumn); setDraftColumn(d.suggestedColumn); }
          });
      });
  }, [connectionId, tableName]);

  async function confirm(column: string) {
    if (!column.trim()) return;
    setBusy(true);
    const r = await fetch(`/api/connections/${connectionId}/watermark-config`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ table: tableName, watermarkCol: column.trim() }),
    });
    const d = await r.json();
    setConfig(d);
    setBusy(false);
  }

  async function disable() {
    setBusy(true);
    await fetch(`/api/connections/${connectionId}/watermark-config?table=${encodeURIComponent(tableName)}`, { method: 'DELETE' });
    setConfig(null);
    setSuggestion(null);
    setBusy(false);
  }

  if (config === undefined) return null;

  return (
    <div className="mb-4 rounded border border-neutral-200 p-2 text-xs dark:border-neutral-800">
      <div className="mb-1 font-medium">Incremental refresh</div>
      {config ? (
        <div className="flex items-center gap-2">
          <span>Enabled on <code className="font-mono">{config.watermarkCol}</code></span>
          <button onClick={disable} disabled={busy} className="rounded border px-2 py-0.5 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800">
            Disable
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-neutral-500">{suggestion ? 'Suggested column:' : 'No timestamp column detected.'}</span>
          <input
            value={draftColumn}
            onChange={(e) => setDraftColumn(e.target.value)}
            placeholder="column name"
            className="w-40 rounded border px-1.5 py-0.5 font-mono dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button onClick={() => confirm(draftColumn)} disabled={busy || !draftColumn.trim()} className="rounded border px-2 py-0.5 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800">
            Confirm
          </button>
        </div>
      )}
    </div>
  );
}
