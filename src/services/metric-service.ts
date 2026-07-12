/** Metric CRUD + execution. Create/update run the SQL through the full choke
 *  point (risk gate included) and validate the (time, value) shape; only after
 *  that does runMetric earn skipRiskGate (app-validated stored SQL). */
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { metrics } from '../db/metric-schema';
import { executeQuery, touchesSensitiveColumns } from './query-executor-service';
import { computeDelta, parseSeries, validateMetricShape, type MetricPoint, type MetricDirection, type TimeGrain } from '../lib/metric-math';

export interface MetricInput {
  name: string;
  description?: string;
  sql: string;
  timeGrain?: TimeGrain;
  direction?: MetricDirection;
}

const GRAINS = new Set(['day', 'week', 'month']);
const DIRECTIONS = new Set(['up_good', 'down_good', 'neutral']);

/** Trial-run the SQL and gate the shape. Owner clicking Create/Save IS the
 *  confirmation, so medium-risk queries run (confirmed=true); high risk stays
 *  blocked and sensitive columns are rejected outright (a metric card is a
 *  passive share-adjacent surface — same posture as pinWidget). */
async function validateMetricSql(connectionId: string, sql: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (await touchesSensitiveColumns(connectionId, sql)) {
    return { ok: false, error: 'Metric SQL touches sensitive columns — not allowed on metric cards' };
  }
  const res = await executeQuery({ connectionId, sql, actor: 'metric-validate', confirmed: true });
  if (res.status === 'blocked') return { ok: false, error: `Blocked: ${res.blockedReason}` };
  if (res.status === 'error') return { ok: false, error: res.errorMessage ?? 'query failed' };
  if (res.status !== 'ok' || !res.result) return { ok: false, error: 'query did not complete' };
  const shape = validateMetricShape(res.result.columns, res.result.rows);
  if (!shape.ok) return { ok: false, error: shape.reason };
  return { ok: true };
}

export async function createMetric(connectionId: string, input: MetricInput) {
  const name = input.name?.trim();
  if (!name) return { error: 'name required' };
  if (!input.sql?.trim()) return { error: 'sql required' };
  if (input.timeGrain && !GRAINS.has(input.timeGrain)) return { error: 'invalid timeGrain' };
  if (input.direction && !DIRECTIONS.has(input.direction)) return { error: 'invalid direction' };
  const v = await validateMetricSql(connectionId, input.sql);
  if (!v.ok) return { error: v.error };
  const [row] = await db.insert(metrics).values({
    connectionId,
    name,
    description: input.description?.trim() || null,
    sql: input.sql.trim(),
    timeGrain: input.timeGrain ?? 'month',
    direction: input.direction ?? 'up_good',
  }).returning();
  return { metric: row };
}

export async function listMetrics(connectionId: string) {
  return db.select().from(metrics).where(eq(metrics.connectionId, connectionId)).orderBy(metrics.createdAt);
}

export async function getMetric(metricId: string) {
  const rows = await db.select().from(metrics).where(eq(metrics.id, metricId)).limit(1);
  return rows[0] ?? null;
}

/** connectionId is intentionally not updatable: validated SQL must never be
 *  replayed against a different database. A SQL change re-runs full validation. */
export async function updateMetric(metricId: string, patch: Partial<MetricInput>) {
  const existing = await getMetric(metricId);
  if (!existing) return { error: 'not found' };
  if (patch.timeGrain && !GRAINS.has(patch.timeGrain)) return { error: 'invalid timeGrain' };
  if (patch.direction && !DIRECTIONS.has(patch.direction)) return { error: 'invalid direction' };
  if (patch.sql && patch.sql.trim() !== existing.sql) {
    const v = await validateMetricSql(existing.connectionId, patch.sql);
    if (!v.ok) return { error: v.error };
  }
  const [row] = await db.update(metrics).set({
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
    ...(patch.sql !== undefined ? { sql: patch.sql.trim() } : {}),
    ...(patch.timeGrain !== undefined ? { timeGrain: patch.timeGrain } : {}),
    ...(patch.direction !== undefined ? { direction: patch.direction } : {}),
  }).where(eq(metrics.id, metricId)).returning();
  return { metric: row };
}

export async function deleteMetric(metricId: string) {
  await db.delete(metrics).where(eq(metrics.id, metricId));
}

export interface MetricRun {
  series: MetricPoint[];
  latest: number | null;
  prev: number | null;
  deltaPct: number | null;
}

export async function runMetric(metricId: string): Promise<{ run?: MetricRun; error?: string }> {
  const metric = await getMetric(metricId);
  if (!metric) return { error: 'not found' };
  const res = await executeQuery({ connectionId: metric.connectionId, sql: metric.sql, actor: 'metric', skipRiskGate: true });
  if (res.status !== 'ok' || !res.result) {
    return { error: res.blockedReason ?? res.errorMessage ?? 'metric query failed' };
  }
  const series = parseSeries(res.result.rows);
  return { run: { series, ...computeDelta(series) } };
}
