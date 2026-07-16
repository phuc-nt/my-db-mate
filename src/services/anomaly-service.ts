/**
 * Anomaly toolkit (P10-B1) — an on-demand stats probe the investigate agent calls
 * to find unusual values. NOT a background monitor and NO historical baseline: it
 * runs a small set of aggregate queries and reports outliers/skew from the current
 * data, as evidence for the agent (a human reads the conclusion).
 *
 * Design (from adversarial review):
 * - ONE combined aggregate SQL per numeric column (not 4-6 separate scans) — bounds
 *   forks + the per-query timeout on big tables.
 * - Variance via two-pass isn't possible in one pass, so we use AVG(c*c)-AVG(c)^2
 *   and CLAMP negatives to 0 (SQLite has no STDDEV; the naive formula can go slightly
 *   negative from float cancellation).
 * - z-score is a plausibility signal, not proof; skewed data produces false positives,
 *   so the report says "possible outliers", never "errors".
 * - EVERY string-valued field (min/max, rarest/dominant category) is returned wrapped
 *   so untrusted DB text can't act as an instruction in the agent's context.
 */
import { and, eq, desc, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { schemaTables, schemaColumns } from '../db/schema';
import { anomalyBaselines } from '../db/anomaly-schema';
import { getConnection } from './connection-service';
import { executeQuery } from './query-executor-service';
import { madOutlier, MIN_MAD_OBS } from '../lib/robust-stats';
import { qualifiedTableRef, quoteColumn } from '../lib/table-ref';

const OUTLIER_Z = 3;
/** Bounded sample size for the in-app MAD outlier check — big enough to represent the
 *  distribution, small enough to bound the scan/cost (matters for BigQuery). */
const SAMPLE_LIMIT = 10_000;
/** Age-based retention for the drift-baseline series (mirrors the monitor's window). */
const BASELINE_RETENTION_DAYS = 90;

/** Wrap an untrusted DB string so it can't be read as an instruction by the agent. */
function wrap(v: unknown): string {
  return `<data>${v == null ? 'null' : String(v)}</data>`;
}

function isNumericType(dataType: string): boolean {
  return /int|real|float|double|numeric|decimal|number/i.test(dataType);
}

async function assertKnownColumn(connectionId: string, table: string, column: string) {
  const [t] = await db.select().from(schemaTables)
    .where(and(eq(schemaTables.connectionId, connectionId), eq(schemaTables.tableName, table)));
  if (!t) throw new Error(`Unknown table: ${table}`);
  const [c] = await db.select().from(schemaColumns)
    .where(and(eq(schemaColumns.tableId, t.id), eq(schemaColumns.columnName, column)));
  if (!c) throw new Error(`Unknown column: ${table}.${column}`);
  return { column: c.columnName, dataType: c.dataType, schemaName: t.schemaName };
}

export interface AnomalyReport {
  table: string;
  column: string;
  total: number;
  nullRate: number;
  numeric?: { avg: number; stddev: number; min: string; max: string; outlierCount: number };
  /** Robust outlier count from median±3·MAD on a bounded sample (resistant to the
   *  masking that inflates σ). Present alongside the σ-based `numeric.outlierCount`. */
  robust?: { median: number; mad: number; outlierCount: number; sampleN: number; method: 'mad' | 'sigma-fallback' };
  /** Drift of this column's distribution vs its own history (from anomaly_baselines):
   *  is the current avg/nullRate an outlier relative to prior probes? Absent on the
   *  first probe or until enough history accumulates. */
  drift?: { avgDrift: boolean; nullRateDrift: boolean; baselineN: number };
  note?: string;
}

/**
 * Detect anomalies in one column. If the column is numeric, reports mean/stddev +
 * a count of |x-mean| > 3σ outliers. NULL-rate is always reported. String fields
 * are wrapped. On timeout/failure, returns a graceful note rather than throwing so
 * the agent doesn't hallucinate around a partial result.
 */
export async function detectAnomalies(connectionId: string, table: string, column: string): Promise<AnomalyReport> {
  const { column: col, dataType, schemaName } = await assertKnownColumn(connectionId, table, column);
  const conn = await getConnection(connectionId);
  if (!conn) return { table, column, total: 0, nullRate: 0, note: 'Connection not found.' };
  const dialect = conn.dialect;
  // BigQuery requires a dataset-qualified table ref; other dialects use a bare quoted name.
  const t = qualifiedTableRef(dialect, table, schemaName);
  const c = quoteColumn(dialect, col);

  /** Run through executeQuery (budgeted for BigQuery). Returns rows, or null on any
   *  non-ok status — the caller degrades to a graceful note, never throws. */
  const run = async (q: string): Promise<unknown[][] | null> => {
    const res = await executeQuery({ connectionId, sql: q, actor: 'anomaly', skipRiskGate: true, backgroundBudgeted: true });
    return res.status === 'ok' && res.result ? res.result.rows : null;
  };

  try {
    if (isNumericType(dataType)) {
      // Totals + TRUE table min/max (cheap portable aggregates), then a bounded sample of
      // values for robust in-app median/MAD + moments — no dialect STDDEV/CAST needed.
      // NOTE ON BIGQUERY COST: the sample `LIMIT` does NOT reduce bytes billed — BigQuery
      // scans the whole column then applies LIMIT. The real cost bound is the daily byte
      // budget (backgroundBudgeted): a too-large column is blocked → graceful note, never
      // an un-budgeted scan. The LIMIT bounds in-app work, not BigQuery billing.
      const totRows = await run(`SELECT COUNT(*) AS n, COUNT(${c}) AS nn, MIN(${c}) AS mn, MAX(${c}) AS mx FROM ${t}`);
      if (!totRows?.[0]) return degraded(table, column);
      const total = Number(totRows[0][0]);
      const nonNull = Number(totRows[0][1]);
      const trueMin = totRows[0][2];
      const trueMax = totRows[0][3];
      const nullRate = total === 0 ? 0 : (total - nonNull) / total;

      const sampleRows = await run(`SELECT ${c} FROM ${t} WHERE ${c} IS NOT NULL LIMIT ${SAMPLE_LIMIT}`);
      if (!sampleRows) return degraded(table, column);
      const values = sampleRows.map((r) => Number(r[0])).filter((v) => Number.isFinite(v));
      const sampled = nonNull > values.length; // the sample didn't cover every value

      const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      const variance = values.length ? values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length : 0;
      const stddev = Math.sqrt(Math.max(0, variance));

      // σ-based count (legacy, for comparison) + robust MAD count (the depth upgrade).
      let sigmaOutliers = 0;
      if (stddev > 0) {
        const lo = mean - OUTLIER_Z * stddev, hi = mean + OUTLIER_Z * stddev;
        sigmaOutliers = values.filter((v) => v < lo || v > hi).length;
      }
      let robust: AnomalyReport['robust'];
      if (values.length >= MIN_MAD_OBS) {
        // Judge each sampled value against the whole sample's median±3·MAD.
        const first = madOutlier(values[0], values, OUTLIER_Z);
        const robustCount = values.filter((v) => madOutlier(v, values, OUTLIER_Z).isOutlier).length;
        robust = { median: first.centre, mad: first.spread, outlierCount: robustCount, sampleN: values.length, method: first.method };
      }

      // Drift baseline is best-effort — a failure here must NOT discard the computed result.
      // Only persist the mean as a baseline when it's a TRUE full-column mean (not a
      // partial, physically-ordered sample that would poison future avg-drift comparisons).
      const drift = await safeComputeDrift(connectionId, table, col, sampled ? null : mean, nullRate);
      await safePersistBaseline(connectionId, table, col, sampled ? null : mean, sampled ? null : stddev, nullRate);

      const robustNote = robust
        ? ` Robust (MAD): ${robust.outlierCount} outlier(s) in a ${robust.sampleN}-row${sampled ? ' non-random' : ''} sample (${robust.method}).`
        : '';
      return {
        table, column: col, total, nullRate,
        // min/max are TRUE table extremes (SQL MIN/MAX); avg/stddev/outliers are from the sample.
        numeric: { avg: mean, stddev, min: wrap(trueMin), max: wrap(trueMax), outlierCount: sigmaOutliers },
        robust, drift,
        note: `${sigmaOutliers} value(s) beyond ${OUTLIER_Z}σ (possible outliers, not necessarily errors).${robustNote}${sampled ? ` avg/stddev/outliers are from the first ${SAMPLE_LIMIT} non-null rows (a non-random sample — physical order); min/max are exact.` : ''}`,
      };
    }

    // Non-numeric: NULL rate + a note (categorical skew is covered by profile_column).
    const rows = await run(`SELECT COUNT(*) AS n, COUNT(${c}) AS nn FROM ${t}`);
    if (!rows?.[0]) return degraded(table, column);
    const total = Number(rows[0][0]);
    const nonNull = Number(rows[0][1]);
    const nullRate = total === 0 ? 0 : (total - nonNull) / total;
    const drift = await safeComputeDrift(connectionId, table, col, null, nullRate);
    await safePersistBaseline(connectionId, table, col, null, null, nullRate);
    return {
      table, column: col, total, nullRate, drift,
      note: 'Non-numeric column: reporting NULL rate only. Use profile_column for categorical value frequencies.',
    };
  } catch (e) {
    return { table, column, total: 0, nullRate: 0, note: `Could not analyze (${e instanceof Error ? e.message : String(e)}) — the table may be too large; try a smaller/sampled scope.` };
  } finally {
    // provider already closed above (only used for dialect quoting).
  }
}

/** Graceful "couldn't run" report — a non-ok executeQuery (BigQuery budget block,
 *  error, or medium-risk confirmation) returns null rows; we never throw. */
function degraded(table: string, column: string): AnomalyReport {
  return { table, column, total: 0, nullRate: 0, note: 'Could not analyze — the query did not run (it may exceed the connection budget, need confirmation, or the table is too large). Try a smaller/sampled scope.' };
}

/** Compare the current probe's avg + nullRate to this column's own history
 *  (anomaly_baselines) via robust MAD — is the distribution DRIFTING over time?
 *  Returns undefined until enough prior probes accumulate (cold-start). */
async function computeDrift(
  connectionId: string, table: string, column: string, curAvg: number | null, curNullRate: number,
): Promise<AnomalyReport['drift']> {
  const cutoff = new Date(Date.now() - BASELINE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db.select({ avg: anomalyBaselines.avg, nullRate: anomalyBaselines.nullRate })
    .from(anomalyBaselines)
    .where(and(
      eq(anomalyBaselines.connectionId, connectionId),
      eq(anomalyBaselines.tableName, table),
      eq(anomalyBaselines.columnName, column),
      sql`${anomalyBaselines.capturedAt} >= ${cutoff}`,
    ))
    .orderBy(desc(anomalyBaselines.capturedAt))
    .limit(200);
  if (rows.length < MIN_MAD_OBS) return undefined;
  const avgSeries = rows.map((r) => r.avg).filter((v): v is number => v != null);
  const nullSeries = rows.map((r) => r.nullRate);
  const avgDrift = curAvg != null && avgSeries.length >= MIN_MAD_OBS
    ? madOutlier(curAvg, avgSeries, OUTLIER_Z).isOutlier : false;
  const nullRateDrift = madOutlier(curNullRate, nullSeries, OUTLIER_Z).isOutlier;
  return { avgDrift, nullRateDrift, baselineN: rows.length };
}

/** Best-effort wrappers: the drift baseline is an ADDITIVE feature — a failure here
 *  (app-DB hiccup, constraint race) must never discard the already-computed anomaly
 *  result by bubbling to the outer catch. */
async function safeComputeDrift(
  connectionId: string, table: string, column: string, curAvg: number | null, curNullRate: number,
): Promise<AnomalyReport['drift']> {
  try {
    return await computeDrift(connectionId, table, column, curAvg, curNullRate);
  } catch {
    return undefined;
  }
}
async function safePersistBaseline(
  connectionId: string, table: string, column: string, avg: number | null, stddev: number | null, nullRate: number,
): Promise<void> {
  try {
    await persistBaseline(connectionId, table, column, avg, stddev, nullRate);
  } catch { /* best-effort — a missed baseline row must not fail the probe */ }
}

/** Append this probe's summary to the drift-baseline series + prune by age. */
async function persistBaseline(
  connectionId: string, table: string, column: string, avg: number | null, stddev: number | null, nullRate: number,
): Promise<void> {
  await db.insert(anomalyBaselines).values({ connectionId, tableName: table, columnName: column, avg, stddev, nullRate });
  const cutoff = new Date(Date.now() - BASELINE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await db.delete(anomalyBaselines).where(and(
    eq(anomalyBaselines.connectionId, connectionId),
    eq(anomalyBaselines.tableName, table),
    eq(anomalyBaselines.columnName, column),
    sql`${anomalyBaselines.capturedAt} < ${cutoff}`,
  ));
}
