'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Line, LineChart, ResponsiveContainer } from 'recharts';
import { computeForecast, formatMetricValue, type MetricPoint, type MetricDirection, type TimeGrain } from '../lib/metric-math';

export interface MetricRowUI {
  id: string;
  name: string;
  description: string | null;
  timeGrain: string;
  direction: string;
  target?: number | null;
  dimensions?: string[] | null;
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

  // Deterministic next-bucket forecast (seasonal-naive ± MAD) computed from the
  // already-fetched series — zero extra queries. Null on cold-start → no render.
  const forecast = useMemo(() => run
    ? computeForecast(run.series, (metric.timeGrain as TimeGrain) || 'month', metric.direction as MetricDirection, metric.target)
    : null,
  [run, metric.timeGrain, metric.direction, metric.target]);

  // Sparkline data: real series plus one dashed forecast point. The last real
  // point carries BOTH keys so the dashed segment connects to the solid line.
  const sparkData = useMemo(() => {
    if (!run) return [];
    const pts: { v?: number; f?: number }[] = run.series.map((p) => ({ v: p.v }));
    if (forecast && pts.length > 0) {
      pts[pts.length - 1] = { ...pts[pts.length - 1], f: run.series[run.series.length - 1].v };
      pts.push({ f: forecast.point });
    }
    return pts;
  }, [run, forecast]);

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
        <span className="flex items-center gap-1">
          {!!metric.dimensions?.length && (
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800" title="Digest reports top drivers per these columns" data-testid="metric-dims">
              ⊞ {metric.dimensions.join(', ')}
            </span>
          )}
          <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800">{metric.timeGrain}</span>
        </span>
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
          {metric.target != null && run.latest != null && (() => {
            // Mirrors computeInsights' target rules: direction decides on/off-track;
            // neutral metrics only show distance, never a judgement color.
            const pct = metric.target === 0 ? null : (run.latest / metric.target) * 100;
            const met = metric.direction === 'up_good' ? run.latest >= metric.target : run.latest <= metric.target;
            const cls = metric.direction === 'neutral' ? 'text-neutral-500'
              : met ? 'text-green-600' : 'text-red-600';
            return (
              <p className={`mt-0.5 text-[11px] ${cls}`} data-testid="metric-goal">
                🎯 {formatMetricValue(metric.target)}{pct != null && ` — ${pct.toFixed(0)}%`}
                {metric.direction !== 'neutral' && (met ? ' · on track' : ' · off track')}
              </p>
            );
          })()}
          {run.series.length > 1 && (
            <div className="mt-1 h-10">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={sparkData}>
                  <Line dataKey="v" stroke="#2563eb" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  {forecast && (
                    <Line dataKey="f" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="3 3" dot={{ r: 2 }} isAnimationActive={false} />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          {forecast && (
            <p className="mt-0.5 text-[11px] text-neutral-400" data-testid="metric-forecast"
              title={`Seasonal-naive forecast (${forecast.method}, ${forecast.n} obs): median of prior same-${metric.timeGrain === 'day' ? 'weekday' : metric.timeGrain === 'month' ? 'month' : 'bucket'} values ± MAD`}>
              next ~{formatMetricValue(forecast.point)} ±{formatMetricValue(forecast.band)}
              {forecast.vsGoal && (
                <span className={forecast.vsGoal === 'at-risk' ? ' text-red-500' : ' text-green-600'}>
                  {' '}· forecast {forecast.vsGoal}
                </span>
              )}
            </p>
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
