/**
 * DuckDB-over-BigQuery (Mode 2, offline analytics).
 *
 * Snapshots an arbitrary BigQuery SELECT into a local Parquet/DuckDB copy ONCE
 * (bounded + budgeted), then serves repeated dashboard/metric/report reads from
 * DuckDB at $0 BigQuery cost until the snapshot's TTL expires. This is the
 * offline counterpart to Mode 1's realtime per-query budget gate.
 *
 * Cost-safety (Red Team #1): the extract IS a real BigQuery job, so its row-fetch
 * is routed through `executeQuery({ backgroundBudgeted: true })` — the SAME single
 * budget-admission point as Mode 1 — NOT `provider.executeReadOnly` directly. A
 * huge extract is blocked by the daily budget / per-query cap exactly like a direct
 * query; there is no un-budgeted path to a BigQuery job. If admission blocks, no
 * snapshot is written.
 *
 * Unlike the OLTP accelerator, this bypasses `planAcceleration`'s table-name model
 * (which only accepts `SELECT * FROM <table>`) and snapshots the caller's arbitrary
 * SELECT verbatim — the low-level `ensureSnapshot`/`extractToParquet` seam already
 * accepts arbitrary SQL; only the OLTP driver hardwired table semantics.
 */
import { getConnection } from '../connection-service';
import { buildProvider, type ConnectionRow } from '../connection-providers/provider-factory';
import { BigQueryConnectionProvider } from '../connection-providers/bigquery-provider';
import type { QueryResult } from '../connection-providers/provider-interface';
import { executeQuery } from '../query-executor-service';
import { ensureSnapshot, type SnapshotFetchRows } from './snapshot-cache-service';
import { runAcceleratedQuery } from './duckdb-executor-service';

const DEFAULT_EXTRACT_TTL_MS = 6 * 60 * 60 * 1000; // 6h — offline data is explicitly cached, staleness surfaced via asOf.

export interface BigQueryExtractResult {
  result: QueryResult;
  /** Snapshot extraction time — surfaced to the UI so a cached (stale) read is visible. */
  asOf: Date;
}

/** Raised when the extract's BigQuery job was refused by the daily budget / per-query
 *  cap (or otherwise didn't run) — no snapshot is written, nothing is served stale. */
export class BigQueryExtractBlockedError extends Error {
  constructor(reason: string) {
    super(`BigQuery extract blocked: ${reason}`);
    this.name = 'BigQueryExtractBlockedError';
  }
}

/**
 * Ensure a DuckDB-over-BigQuery snapshot of `sql` exists (extracting through the
 * budget gate when stale/absent), then return its rows read from the local DuckDB
 * copy — zero BigQuery cost on the read. Only valid for BigQuery connections.
 */
export async function extractBigQueryToDuckDB(
  connectionId: string,
  sql: string,
  ttlMs: number = DEFAULT_EXTRACT_TTL_MS,
): Promise<BigQueryExtractResult> {
  const conn = await getConnection(connectionId);
  if (!conn) throw new Error('Connection not found');
  const provider = buildProvider(conn as unknown as ConnectionRow);
  if (!(provider instanceof BigQueryConnectionProvider)) {
    throw new Error('DuckDB-over-BigQuery extract is only valid for BigQuery connections');
  }

  // The extract's row-fetch goes through executeQuery's budget admission — the ONE
  // enforcement point. A blocked/errored admission throws, so no snapshot is written.
  const fetchRows: SnapshotFetchRows = async (extractSql) => {
    const res = await executeQuery({
      connectionId,
      sql: extractSql,
      actor: 'accelerator-extract',
      backgroundBudgeted: true,
      _bypassOfflineMode: true, // Prevent infinite recursion when extracting from an offline-mode connection
    });
    if (res.status !== 'ok' || !res.result) {
      throw new BigQueryExtractBlockedError(res.blockedReason ?? res.errorMessage ?? res.status);
    }
    return { columns: res.result.columns, rows: res.result.rows };
  };

  const { path, asOf } = await ensureSnapshot(connectionId, provider, sql, ttlMs, fetchRows);

  // The snapshot Parquet IS the extract's result set; read it straight back from
  // DuckDB under a fixed view name — $0 BigQuery cost.
  const result = await runAcceleratedQuery('SELECT * FROM bq_extract', new Map([['bq_extract', path]]));
  return { result, asOf };
}
