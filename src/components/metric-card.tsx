'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Line, LineChart, ResponsiveContainer } from 'recharts';
import { formatMetricValue, type MetricPoint } from '../lib/metric-math';

export interface MetricRowUI {
  id: string;
  name: string;
  description: string | null;
  timeGrain: string;
  direction: string;
}

/** One metric card: latest value + delta badge + axis-less sparkline. Runs the
 *  metric live on mount (V1 — snapshots are backlog if this gets slow). */
export function MetricCard({ connectionId, metric, onEdit, onDelete }: {
  connectionId: string;
  metric: MetricRowUI;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [run, setRun] = useState<{ series: MetricPoint[]; latest: number | null; deltaPct: number | null } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(`/api/connections/${connectionId}/metrics/${metric.id}/run`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setRun(d)))
      .catch((e) => setError(String(e)));
  }, [connectionId, metric.id]);

  // Delta badge color follows the metric's direction: growth is only "good"
  // when the owner said up is good.
  const delta = run?.deltaPct ?? null;
  const goodness = metric.direction === 'neutral' || delta == null ? 'neutral'
    : (delta >= 0) === (metric.direction === 'up_good') ? 'good' : 'bad';
  const badgeCls = goodness === 'good' ? 'bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400'
    : goodness === 'bad' ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400'
    : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400';

  return (
    <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800" data-testid="metric-card">
      <div className="flex items-start justify-between gap-2">
        <Link href={`/db/${connectionId}/chat?q=${encodeURIComponent(`Analyze the metric "${metric.name}" — recent trend, drivers, anomalies`)}`}
          className="text-sm font-medium hover:underline" title="Analyze in chat">{metric.name}</Link>
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800">{metric.timeGrain}</span>
      </div>
      {metric.description && <p className="mt-0.5 text-[11px] text-neutral-500">{metric.description}</p>}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {!run && !error && <p className="mt-2 text-xs text-neutral-400">Loading…</p>}
      {run && (
        <>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-2xl font-semibold" data-testid="metric-latest">{formatMetricValue(run.latest)}</span>
            {delta != null && (
              <span className={`rounded px-1.5 py-0.5 text-[11px] ${badgeCls}`} data-testid="metric-delta">
                {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}%
              </span>
            )}
          </div>
          {run.series.length > 1 && (
            <div className="mt-1 h-10">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={run.series}>
                  <Line dataKey="v" stroke="#2563eb" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
      <div className="mt-2 flex gap-2 text-[11px] text-neutral-500">
        <button onClick={onEdit} className="hover:underline">Edit</button>
        <button onClick={onDelete} className="hover:underline">Delete</button>
      </div>
    </div>
  );
}
