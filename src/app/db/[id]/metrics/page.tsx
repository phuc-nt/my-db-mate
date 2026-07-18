'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { FormModal, type FormModalField } from '../../../../components/form-modal';
import { MetricCard, type MetricRowUI } from '../../../../components/metric-card';

interface MetricRow extends MetricRowUI { sql: string; dimensions?: string[] | null }

const METRIC_FIELDS = (m?: MetricRow): FormModalField[] => [
  { name: 'name', label: 'Metric name', required: true, defaultValue: m?.name ?? '' },
  { name: 'description', label: 'Description (optional — improves chat matching; a line in your query language helps cross-lingual retrieval)', defaultValue: m?.description ?? '' },
  { name: 'sql', label: 'SQL — must return exactly (time_bucket, value)', type: 'textarea', mono: true, required: true, defaultValue: m?.sql ?? '' },
  { name: 'target', label: 'Target (optional — goal for the latest value)', defaultValue: m?.target != null ? String(m.target) : '' },
  { name: 'dimensions', label: 'Dimensions (optional, ≤3 columns comma-separated — digest reports top drivers per slice)', defaultValue: (m?.dimensions ?? []).join(', ') },
  { name: 'timeGrain', label: 'Time grain', type: 'select', defaultValue: m?.timeGrain ?? 'month', options: [
    { value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' },
  ] },
  { name: 'direction', label: 'Good direction', type: 'select', defaultValue: m?.direction ?? 'up_good', options: [
    { value: 'up_good', label: '▲ Up is good (revenue, signups)' },
    { value: 'down_good', label: '▼ Down is good (errors, churn)' },
    { value: 'neutral', label: 'Neutral' },
  ] },
];

/** Metrics tab: tracked KPIs for this connection as sparkline cards. */
export default function MetricsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [list, setList] = useState<MetricRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<MetricRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setList(await (await fetch(`/api/connections/${id}/metrics`)).json());
    setLoaded(true);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function save(values: Record<string, string>, metricId?: string) {
    setMsg('');
    // The form posts dimensions as a comma-separated string — the API wants string[].
    const dims = (values.dimensions ?? '').split(',').map((d) => d.trim()).filter(Boolean);
    const body = { ...values, dimensions: dims.length ? dims : null };
    const r = await fetch(metricId ? `/api/connections/${id}/metrics/${metricId}` : `/api/connections/${id}/metrics`, {
      method: metricId ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg(d.error ?? 'save failed'); return; }
    setMsg(metricId ? 'Updated ✓' : 'Metric created ✓');
    load();
  }

  /** Pulse-style digest schedule over this connection's metrics (server enforces
   *  the hourly cost floor — one LLM call per run). */
  async function createDigest(v: Record<string, string>) {
    setMsg('');
    const r = await fetch(`/api/connections/${id}/schedules`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', name: v.name, mode: 'metrics_digest', cron: v.cron, webhookUrl: v.webhookUrl || undefined, config: v.quiet === 'yes' ? { quiet: true } : undefined }),
    });
    const d = await r.json().catch(() => ({}));
    setMsg(r.ok ? 'Digest scheduled ✓ — manage in Automations' : (d.error ?? 'schedule failed'));
  }

  async function remove(metricId: string) {
    await fetch(`/api/connections/${id}/metrics/${metricId}`, { method: 'DELETE' });
    load();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">📈 Metrics</h2>
        <div className="flex gap-2">
          {list.length > 0 && (
            <button onClick={() => setDigestOpen(true)} className="rounded border px-3 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800" data-testid="digest-schedule">
              ⏰ Digest schedule
            </button>
          )}
          <button onClick={() => setCreating(true)} className="rounded bg-blue-600 px-3 py-1 text-xs text-white" data-testid="new-metric">
            + New metric
          </button>
        </div>
      </div>
      {msg && <p className="text-xs text-green-600" data-testid="metric-msg">{msg}</p>}
      {loaded && list.length === 0 && (
        <div className="rounded border border-dashed border-neutral-300 p-6 text-center text-xs text-neutral-500 dark:border-neutral-700">
          <p>No metrics yet. A metric is a SQL query returning (time_bucket, value) — tracked as a card with sparkline and delta.</p>
          <p className="mt-1">Fastest path: ask something like &quot;monthly revenue&quot; in Chat, then hit <b>📈 Track as metric</b> on the result.</p>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((m) => (
          <MetricCard key={m.id} connectionId={id} metric={m} onEdit={() => setEditing(m)} onDelete={() => remove(m.id)} />
        ))}
      </div>
      {digestOpen && (
        <FormModal open title="Schedule a metrics digest" submitLabel="Create schedule"
          fields={[
            { name: 'name', label: 'Schedule name', defaultValue: 'Metrics digest', required: true },
            { name: 'cron', label: 'Cron — hourly or less often, exact minute (1 LLM call per run)', type: 'select', defaultValue: '0 7 * * 1', options: [
              { value: '0 7 * * 1', label: 'Weekly — Monday 07:00' },
              { value: '0 7 * * *', label: 'Daily — 07:00' },
              { value: '0 * * * *', label: 'Hourly' },
            ] },
            { name: 'webhookUrl', label: 'Webhook URL (optional — digest markdown is POSTed; empty = view in Automations)' },
            { name: 'quiet', label: 'Quiet mode', type: 'select', defaultValue: 'no', options: [
              { value: 'no', label: 'Always send' },
              { value: 'yes', label: 'Only send when something changed (no LLM call when all quiet)' },
            ] },
          ]}
          onSubmit={(v) => { setDigestOpen(false); createDigest(v); }} onClose={() => setDigestOpen(false)} />
      )}
      {(creating || editing) && (
        <FormModal open title={editing ? `Edit "${editing.name}"` : 'New metric'} submitLabel={editing ? 'Save' : 'Create'}
          fields={METRIC_FIELDS(editing ?? undefined)}
          onSubmit={(v) => { const ed = editing; setCreating(false); setEditing(null); save(v, ed?.id); }}
          onClose={() => { setCreating(false); setEditing(null); }} />
      )}
    </div>
  );
}
