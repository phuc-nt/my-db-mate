/** Metric CRUD + execution. Create/update run the SQL through the full choke
 *  point (risk gate included) and validate the (time, value) shape; only after
 *  that does runMetric earn skipRiskGate (app-validated stored SQL). */
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { metrics } from '../db/metric-schema';
import { executeQuery, touchesSensitiveColumns } from './query-executor-service';
import { getConnection } from './connection-service';
import { rewriteWithDimension } from '../lib/sql-dimension-rewrite';
import { computeDelta, computeDrivers, parseSeries, validateMetricShape, type DriverBreakdown, type MetricPoint, type MetricDirection, type TimeGrain } from '../lib/metric-math';

export interface MetricInput {
  name: string;
  description?: string;
  sql: string;
  timeGrain?: TimeGrain;
  direction?: MetricDirection;
  /** Goal value; forms post strings — coerced/validated by parseTarget. */
  target?: number | string | null;
  /** ≤3 plain column names the digest slices by for top-driver breakdowns. */
  dimensions?: string[] | null;
}

export const MAX_DIMENSIONS = 3;

/** Validate each dimension by rewriting the metric SQL and trial-running the
 *  driver query through the full gate — a broken dimension fails AT SAVE with
 *  the dimension named, never silently at digest time. */
async function validateDimensions(connectionId: string, sql: string, dims: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  if (dims.length > MAX_DIMENSIONS) return { ok: false, error: `at most ${MAX_DIMENSIONS} dimensions` };
  const conn = await getConnection(connectionId);
  if (!conn) return { ok: false, error: 'connection not found' };
  for (const dim of dims) {
    const rw = rewriteWithDimension(sql, dim, conn.dialect);
    if ('error' in rw) return { ok: false, error: `dimension "${dim}": ${rw.error}` };
    // The dimension may itself be a sensitive column the base SQL never touched.
    if (await touchesSensitiveColumns(connectionId, rw.sql)) {
      return { ok: false, error: `dimension "${dim}" is marked sensitive — not allowed on metrics` };
    }
    const res = await executeQuery({ connectionId, sql: rw.sql, actor: 'metric-validate', confirmed: true });
    if (res.status !== 'ok' || !res.result) {
      return { ok: false, error: `dimension "${dim}": ${res.blockedReason ?? res.errorMessage ?? 'driver query failed'}` };
    }
    if (res.result.columns.length !== 3) {
      return { ok: false, error: `dimension "${dim}": driver query returned ${res.result.columns.length} columns, expected (time, value, ${dim})` };
    }
  }
  return { ok: true };
}

/** Normalize a dimensions payload: undefined = not provided, null/[] = clear. */
function parseDimensions(raw: string[] | null | undefined): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const dims = raw.map((d) => String(d).trim()).filter(Boolean);
  return dims.length === 0 ? null : dims;
}

/** Coerce a form/API target into number | null. Undefined = "not provided"
 *  (update keeps the old value); '' and null clear it. */
function parseTarget(raw: number | string | null | undefined): { ok: true; value: number | null } | { ok: false } | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return { ok: true, value: null };
  const n = Number(raw);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
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
  const target = parseTarget(input.target);
  if (target && !target.ok) return { error: 'target must be a number' };
  const dims = parseDimensions(input.dimensions);
  const v = await validateMetricSql(connectionId, input.sql);
  if (!v.ok) return { error: v.error };
  if (dims) {
    const dv = await validateDimensions(connectionId, input.sql.trim(), dims);
    if (!dv.ok) return { error: dv.error };
  }
  const [row] = await db.insert(metrics).values({
    connectionId,
    name,
    description: input.description?.trim() || null,
    sql: input.sql.trim(),
    timeGrain: input.timeGrain ?? 'month',
    direction: input.direction ?? 'up_good',
    target: target?.ok ? target.value : null,
    dimensions: dims ?? null,
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
  const target = parseTarget(patch.target);
  if (target && !target.ok) return { error: 'target must be a number' };
  const dims = parseDimensions(patch.dimensions);
  const sqlChanged = patch.sql != null && patch.sql.trim() !== existing.sql;
  if (sqlChanged) {
    const v = await validateMetricSql(existing.connectionId, patch.sql!);
    if (!v.ok) return { error: v.error };
  }
  // Re-validate dimensions when THEY change OR the SQL changes — a new SQL can
  // break a previously-valid dimension rewrite.
  const effectiveDims = dims !== undefined ? dims : (existing.dimensions ?? null);
  if (effectiveDims && (dims !== undefined || sqlChanged)) {
    const effectiveSql = (patch.sql ?? existing.sql).trim();
    const dv = await validateDimensions(existing.connectionId, effectiveSql, effectiveDims);
    if (!dv.ok) return { error: dv.error };
  }
  const [row] = await db.update(metrics).set({
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
    ...(patch.sql !== undefined ? { sql: patch.sql.trim() } : {}),
    ...(patch.timeGrain !== undefined ? { timeGrain: patch.timeGrain } : {}),
    ...(patch.direction !== undefined ? { direction: patch.direction } : {}),
    ...(target !== undefined ? { target: target.value } : {}),
    ...(dims !== undefined ? { dimensions: dims } : {}),
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

/** Slice a metric by its declared dimensions for the digest's top-driver
 *  section. Digest-only — cards never call this (keeps them light).
 *  Per-dimension failures degrade to an error string, never a throw. */
export async function runMetricDrivers(metricId: string, latestT: string, prevT: string): Promise<{ drivers: DriverBreakdown[]; errors: string[] }> {
  const metric = await getMetric(metricId);
  const drivers: DriverBreakdown[] = [];
  const errors: string[] = [];
  if (!metric || !metric.dimensions?.length) return { drivers, errors };
  const conn = await getConnection(metric.connectionId);
  if (!conn) return { drivers, errors: ['connection not found'] };
  for (const dim of metric.dimensions) {
    const rw = rewriteWithDimension(metric.sql, dim, conn.dialect);
    if ('error' in rw) { errors.push(`${dim}: ${rw.error}`); continue; }
    // Columns can be flagged sensitive AFTER the metric was saved — re-check.
    if (await touchesSensitiveColumns(metric.connectionId, rw.sql)) {
      errors.push(`${dim}: column now marked sensitive — skipped`);
      continue;
    }
    const res = await executeQuery({ connectionId: metric.connectionId, sql: rw.sql, actor: 'metric-driver', skipRiskGate: true });
    if (res.status !== 'ok' || !res.result) { errors.push(`${dim}: ${res.blockedReason ?? res.errorMessage ?? 'failed'}`); continue; }
    if (res.result.rows.length >= rw.cap) {
      // Truncated driver data would produce confidently wrong numbers — skip.
      errors.push(`${dim}: driver rows hit the ${rw.cap}-row cap — breakdown skipped as unreliable`);
      continue;
    }
    drivers.push(computeDrivers(res.result.rows, dim, latestT, prevT));
  }
  return { drivers, errors };
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
