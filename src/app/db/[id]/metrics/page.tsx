'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { FormModal, type FormModalField } from '../../../../components/form-modal';
import { MetricCard, type MetricRowUI } from '../../../../components/metric-card';

interface MetricRow extends MetricRowUI { sql: string }

const METRIC_FIELDS = (m?: MetricRow): FormModalField[] => [
  { name: 'name', label: 'Metric name', required: true, defaultValue: m?.name ?? '' },
  { name: 'description', label: 'Description (optional)', defaultValue: m?.description ?? '' },
  { name: 'sql', label: 'SQL — must return exactly (time_bucket, value)', type: 'textarea', mono: true, required: true, defaultValue: m?.sql ?? '' },
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
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setList(await (await fetch(`/api/connections/${id}/metrics`)).json());
    setLoaded(true);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function save(values: Record<string, string>, metricId?: string) {
    setMsg('');
    const r = await fetch(metricId ? `/api/connections/${id}/metrics/${metricId}` : `/api/connections/${id}/metrics`, {
      method: metricId ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(values),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg(d.error ?? 'save failed'); return; }
    setMsg(metricId ? 'Updated ✓' : 'Metric created ✓');
    load();
  }

  async function remove(metricId: string) {
    await fetch(`/api/connections/${id}/metrics/${metricId}`, { method: 'DELETE' });
    load();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">📈 Metrics</h2>
        <button onClick={() => setCreating(true)} className="rounded bg-blue-600 px-3 py-1 text-xs text-white" data-testid="new-metric">
          + New metric
        </button>
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
      {(creating || editing) && (
        <FormModal open title={editing ? `Edit "${editing.name}"` : 'New metric'} submitLabel={editing ? 'Save' : 'Create'}
          fields={METRIC_FIELDS(editing ?? undefined)}
          onSubmit={(v) => { const ed = editing; setCreating(false); setEditing(null); save(v, ed?.id); }}
          onClose={() => { setCreating(false); setEditing(null); }} />
      )}
    </div>
  );
}
