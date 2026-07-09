/**
 * Risk scoring (P3) — a PERFORMANCE / blast-radius guard, NOT a security control
 * (security lives in safety-service + the SELECT-only grant, RT-F8-sec). Runs
 * EXPLAIN via the provider AFTER the safety gate passes and maps the estimate to
 * a tier. Estimate-based, so it is intentionally NOT deterministic across stats
 * refreshes; tier boundaries use hysteresis margins to avoid oscillation (RT-F12).
 */
import type { ConnectionProvider } from './connection-providers/provider-interface';

export type RiskTier = 'low' | 'medium' | 'high';

export interface RiskAssessment {
  tier: RiskTier;
  score: number; // 0-100
  reason: string;
  estimate: { estimatedRows: number | null; hasFullScan: boolean; tableCount: number };
}

// Row thresholds with hysteresis: a query near a boundary won't flip on small
// estimate changes because the bands are wide and explicit.
const MEDIUM_ROWS = 100_000;
const HIGH_ROWS = 5_000_000;

export async function assessRisk(
  provider: ConnectionProvider,
  sql: string,
  opts?: {
    sensitiveColumnsTouched?: boolean;
    /** Largest known row count among referenced tables (red-team C3). Lets a
     *  SQLite full scan on a big table escalate even though EXPLAIN gives no
     *  row estimate for SQLite. */
    maxTableRows?: number | null;
  },
): Promise<RiskAssessment> {
  let estimate: { estimatedRows: number | null; estimatedCost: number | null; hasFullScan: boolean; tableCount: number };
  try {
    estimate = await provider.explainQuery(sql);
  } catch {
    // Could not estimate → escalate rather than default-low (RT-F10 for MariaDB
    // and any dialect whose EXPLAIN shape we can't parse).
    return { tier: 'medium', score: 50, reason: 'Could not estimate cost (EXPLAIN failed) — escalated', estimate: { estimatedRows: null, hasFullScan: false, tableCount: 0 } };
  }

  const rows = estimate.estimatedRows;
  const reasons: string[] = [];
  let score = 0;

  if (rows == null) {
    // No row estimate (SQLite, or MySQL cost-only). Use structural signals, refined
    // by the largest referenced table's size when we know it (red-team C2/C3).
    const big = opts?.maxTableRows ?? null;
    if (big != null) {
      // We know how big the biggest referenced table is → score by real size, not
      // by a blind table-count heuristic. This is both the C3 escalation (a full
      // scan over a large table is genuinely expensive) AND a false-positive fix:
      // a scan/join over small tables (e.g. a COUNT over two 46-row tables) is cheap.
      if (estimate.hasFullScan) {
        if (big >= HIGH_ROWS) { score += 80; reasons.push(`full scan over a ~${big.toLocaleString()}-row table`); }
        else if (big >= MEDIUM_ROWS) { score += 40; reasons.push(`full scan over a ~${big.toLocaleString()}-row table`); }
        else { score += 10; reasons.push('full scan over small table(s)'); }
      }
    } else {
      // No size info at all (rowCount unsynced, un-ANALYZEd PG, name-match miss).
      // A full scan over a table of UNKNOWN size must NOT be treated as cheap — that
      // would defeat the big-table guard exactly when stats are missing (review H-1).
      // Escalate to medium, mirroring the EXPLAIN-failed escalation above.
      if (estimate.hasFullScan) { score += 40; reasons.push('full scan over a table of unknown size'); }
      if (estimate.tableCount >= 2) { score += estimate.tableCount * 12; reasons.push(`${estimate.tableCount} tables`); }
    }
  } else {
    if (rows >= HIGH_ROWS) { score += 80; reasons.push(`~${rows.toLocaleString()} rows examined`); }
    else if (rows >= MEDIUM_ROWS) { score += 50; reasons.push(`~${rows.toLocaleString()} rows examined`); }
    else { score += Math.floor((rows / MEDIUM_ROWS) * 20); }
    if (estimate.hasFullScan) { score += 15; reasons.push('full/seq scan'); }
    if (estimate.tableCount > 3) { score += 10; reasons.push(`${estimate.tableCount} tables joined`); }
  }

  if (opts?.sensitiveColumnsTouched) { score += 25; reasons.push('touches sensitive columns'); }

  score = Math.min(100, score);
  const tier: RiskTier = score >= 70 ? 'high' : score >= 35 ? 'medium' : 'low';
  return {
    tier,
    score,
    reason: reasons.length ? reasons.join('; ') : 'light query',
    estimate: { estimatedRows: rows, hasFullScan: estimate.hasFullScan, tableCount: estimate.tableCount },
  };
}
