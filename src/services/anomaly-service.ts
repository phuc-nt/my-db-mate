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
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { schemaTables, schemaColumns } from '../db/schema';
import { getProvider } from './connection-service';
import type { ConnectionProvider } from './connection-providers/provider-interface';

const OUTLIER_Z = 3;

function ident(provider: ConnectionProvider, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_]/g, '');
  return provider.dialect === 'mysql' ? `\`${safe}\`` : `"${safe}"`;
}

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
  return { column: c.columnName, dataType: c.dataType };
}

export interface AnomalyReport {
  table: string;
  column: string;
  total: number;
  nullRate: number;
  numeric?: { avg: number; stddev: number; min: string; max: string; outlierCount: number };
  note?: string;
}

/**
 * Detect anomalies in one column. If the column is numeric, reports mean/stddev +
 * a count of |x-mean| > 3σ outliers. NULL-rate is always reported. String fields
 * are wrapped. On timeout/failure, returns a graceful note rather than throwing so
 * the agent doesn't hallucinate around a partial result.
 */
export async function detectAnomalies(connectionId: string, table: string, column: string): Promise<AnomalyReport> {
  const { column: col, dataType } = await assertKnownColumn(connectionId, table, column);
  const provider = await getProvider(connectionId);
  try {
    const t = ident(provider, table);
    const c = ident(provider, col);

    if (isNumericType(dataType)) {
      // ONE combined query: totals + moments (avg, avg of squares) + min/max.
      // CAST to REAL so c*c on a large integer column doesn't overflow int64
      // before AVG (review High-3 — corrupts stddev + the outlier bounds).
      const res = await provider.executeReadOnly(
        `SELECT COUNT(*) AS n, COUNT(${c}) AS nn, AVG(CAST(${c} AS REAL)) AS avg, AVG(CAST(${c} AS REAL)*CAST(${c} AS REAL)) AS avgsq, MIN(${c}) AS mn, MAX(${c}) AS mx FROM ${t}`,
        { timeoutMs: 30_000 },
      );
      const [n, nn, avg, avgsq, mn, mx] = res.rows[0] as [number, number, number, number, unknown, unknown];
      const total = Number(n);
      const nonNull = Number(nn);
      const nullRate = total === 0 ? 0 : (total - nonNull) / total;
      const mean = Number(avg) || 0;
      const variance = Math.max(0, Number(avgsq) - mean * mean); // clamp float cancellation
      const stddev = Math.sqrt(variance);

      let outlierCount = 0;
      if (stddev > 0) {
        const lo = mean - OUTLIER_Z * stddev;
        const hi = mean + OUTLIER_Z * stddev;
        const oc = await provider.executeReadOnly(
          `SELECT COUNT(*) FROM ${t} WHERE ${c} < ${lo} OR ${c} > ${hi}`,
          { timeoutMs: 30_000 },
        );
        outlierCount = Number(oc.rows[0][0]);
      }
      return {
        table, column: col, total, nullRate,
        numeric: { avg: mean, stddev, min: wrap(mn), max: wrap(mx), outlierCount },
        note: `${outlierCount} value(s) beyond ${OUTLIER_Z}σ (possible outliers, not necessarily errors). Skewed distributions inflate this.`,
      };
    }

    // Non-numeric: NULL rate + a note (categorical skew is covered by profile_column).
    const res = await provider.executeReadOnly(`SELECT COUNT(*) AS n, COUNT(${c}) AS nn FROM ${t}`, { timeoutMs: 30_000 });
    const total = Number(res.rows[0][0]);
    const nonNull = Number(res.rows[0][1]);
    return {
      table, column: col, total,
      nullRate: total === 0 ? 0 : (total - nonNull) / total,
      note: 'Non-numeric column: reporting NULL rate only. Use profile_column for categorical value frequencies.',
    };
  } catch (e) {
    return { table, column, total: 0, nullRate: 0, note: `Could not analyze (${e instanceof Error ? e.message : String(e)}) — the table may be too large; try a smaller/sampled scope.` };
  } finally {
    await provider.close();
  }
}
