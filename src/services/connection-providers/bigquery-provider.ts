/**
 * BigQuery warehouse-connector provider (Dialect: 'bigquery').
 *
 * Cost-safety is this provider's `estimateCost()` (dry-run) + the
 * `maximumBytesBilled` cap baked into every real `executeReadOnly()` call —
 * the two independent layers Phase 3 exists to build. `explainQuery()` still
 * deliberately throws rather than degrade silently — BigQuery cost/blast-radius
 * uses `estimateCost()`, a dollar-denominated dry-run, not EXPLAIN's row-based
 * shape, and risk-scoring-service.ts already treats an EXPLAIN failure as
 * fail-safe (escalates to tier: 'medium'), which is the correct behavior there.
 *
 * `maximumBytesBilled` is constructor-injected (from the connection's
 * `bigqueryMaxBytesPerQuery`), never a per-call option a caller could forget to
 * pass — see Phase 3's Architecture note for why.
 */
import { BigQuery } from '@google-cloud/bigquery';
import type {
  ConnectionProvider,
  Dialect,
  IntrospectedSchema,
  QueryResult,
  WritePrivilegeProbe,
  ColumnInfo,
} from './provider-interface';

export interface BigQueryConfig {
  projectId: string;
  /** Parsed service-account JSON (client_email + private_key, at minimum). */
  credentials: Record<string, unknown>;
  /** Hard cap for `maximumBytesBilled` on every real query this provider runs.
   *  Constructor-injected from the connection row's bigqueryMaxBytesPerQuery —
   *  Phase 3 reads this via the provider, not a per-call param. */
  maximumBytesBilled: number;
}

export interface CostEstimate {
  estimatedBytes: number;
  estimatedCostUsd: number;
  /** false when the dry-run reported 0 bytes for a non-trivial query — a known
   *  dry-run blind spot (e.g. some external/federated table shapes). Layer 2
   *  (`maximumBytesBilled`) is the real backstop regardless of this flag. */
  reliable: boolean;
}

/** Distinct from a "the estimate came back but the query is expensive" result —
 *  thrown when the dry-run job itself fails (malformed SQL, permission error,
 *  network/credential failure). Callers must fail closed on this, not proceed
 *  with a fabricated estimate or a generic error. */
export class EstimateFailedError extends Error {
  constructor(cause: unknown) {
    super(sanitizeBigQueryConnError(cause));
    this.name = 'EstimateFailedError';
  }
}

/** Thrown when a real (non-dry-run) query exceeds the connection's configured
 *  `maximumBytesBilled` — BigQuery rejects the job before any bytes are billed.
 *  Distinguishable from a generic execution error so callers can surface a
 *  specific, actionable message instead of a 500. */
export class MaximumBytesBilledExceededError extends Error {
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`Query exceeds the configured cost cap and was rejected before running (zero cost incurred): ${msg}`);
    this.name = 'MaximumBytesBilledExceededError';
  }
}

/** BigQuery's job rejection for exceeding `maximumBytesBilled` — empirically
 *  confirmed 2026-07-16 against a real project (see
 *  `scripts/verify-bigquery-cost-cap.ts` and Phase 3's phase file verification
 *  note): the `@google-cloud/bigquery` client throws an `Error` carrying an
 *  `errors` array whose first entry has `reason: "bytesBilledLimitExceeded"`
 *  (message observed: "Query exceeded limit for bytes billed: <cap>. <required>
 *  or higher required."). Match on `reason`, not the free-text message — it's
 *  the structured, documented field and won't break if Google reword the
 *  message. Centralized here so both `estimateCost` (dry-run) and
 *  `executeReadOnly` (real run) recognize the same shape. */
function isMaximumBytesBilledError(e: unknown): boolean {
  const errors = (e as { errors?: Array<{ reason?: string }> })?.errors;
  return Array.isArray(errors) && errors.some((err) => err.reason === 'bytesBilledLimitExceeded');
}

// $6.25 per TiB scanned — BigQuery on-demand pricing (per Phase 3's Requirements).
const USD_PER_TIB = 6.25;
const BYTES_PER_TIB = 1024 ** 4;
const MIN_ESTIMATED_COST_USD = 0.01;

/** BigQuery auth errors (via google-auth-library) can embed client_email/project/
 *  key-metadata diagnostics in e.message — this codebase's default pattern
 *  (connection-service.ts's sanitizeConnError) returns e.message raw to the
 *  client, which would leak that here. Mirror the same deliberate deviation. */
export function sanitizeBigQueryConnError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/(client_email|private_key|invalid_grant|invalid_rapt|JWT|service account|credentials)/i.test(msg)) {
    console.error('[bigquery] connection error:', msg);
    return 'BigQuery authentication failed: check the service-account JSON, project ID, and granted IAM roles (roles/bigquery.dataViewer + roles/bigquery.jobUser).';
  }
  return msg;
}

/** BigQuery cell values that aren't JSON-primitive: DATE/DATETIME/TIME/TIMESTAMP
 *  come back as wrapper objects with a `.value` string; INT64 can come back as a
 *  `Big`-like object with `.toString()`. Normalize to primitives so downstream
 *  serialization (toJsonSafe) sees plain strings/numbers, not driver-specific
 *  wrapper shapes the way pg/mysql2 never produce. */
function normalizeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    return (v as { value: unknown }).value;
  }
  return v;
}

export class BigQueryConnectionProvider implements ConnectionProvider {
  readonly dialect: Dialect = 'bigquery';
  private readonly client: BigQuery;

  constructor(private readonly config: BigQueryConfig) {
    // Schema-impossible per the connections table's `.notNull()` default, but
    // defend anyway: fail closed at construction rather than let executeReadOnly()
    // run uncapped (Phase 3 Requirements).
    if (!config.maximumBytesBilled || config.maximumBytesBilled <= 0) {
      throw new Error('BigQuery provider requires a positive maximumBytesBilled cap');
    }
    this.client = new BigQuery({
      projectId: config.projectId,
      credentials: config.credentials,
    });
  }

  async testConnection(): Promise<void> {
    try {
      // Trivial metadata call — no bytes billed, just confirms auth + project access.
      await this.client.getDatasets({ maxResults: 1 });
    } catch (e) {
      throw new Error(sanitizeBigQueryConnError(e));
    }
  }

  async probeWritePrivilege(): Promise<WritePrivilegeProbe> {
    // Never live-probe a write against a paid warehouse. The real safety boundary
    // is the IAM grant (roles/bigquery.dataViewer + roles/bigquery.jobUser, no
    // write/editor role) — documented, not tested at runtime.
    return {
      isReadOnly: true,
      detail: 'read-only by IAM grant (roles/bigquery.dataViewer + roles/bigquery.jobUser, no write role) — not probed live',
    };
  }

  async introspectSchema(): Promise<IntrospectedSchema> {
    const tables: IntrospectedSchema['tables'] = [];
    const columns: ColumnInfo[] = [];

    let datasetsResult;
    try {
      datasetsResult = await this.client.getDatasets();
    } catch (e) {
      throw new Error(sanitizeBigQueryConnError(e));
    }
    const [datasets] = datasetsResult;

    for (const dataset of datasets) {
      let dsTables;
      try {
        dsTables = (await dataset.getTables())[0];
      } catch (e) {
        // The service account may only have dataViewer on a subset of datasets —
        // skip inaccessible datasets with a visible note rather than failing the
        // whole introspection call.
        console.warn(`[bigquery] skipping dataset ${dataset.id} (introspection failed): ${sanitizeBigQueryConnError(e)}`);
        continue;
      }

      for (const table of dsTables) {
        try {
          const [metadata] = await table.getMetadata();
          const schemaName = dataset.id ?? null;
          const tableName = table.id ?? '';
          const numRows = metadata.numRows != null ? Number(metadata.numRows) : null;
          tables.push({
            schemaName,
            tableName,
            rowCount: Number.isFinite(numRows) ? numRows : null,
          });
          const fields = (metadata.schema?.fields ?? []) as { name: string; type: string; mode?: string }[];
          fields.forEach((f, i) => {
            columns.push({
              tableName,
              schemaName,
              columnName: f.name,
              dataType: f.type,
              isNullable: f.mode !== 'REQUIRED',
              isPrimaryKey: false, // BigQuery has no primary-key concept at the storage layer.
              ordinalPosition: i,
            });
          });
        } catch (e) {
          console.warn(`[bigquery] skipping table ${dataset.id}.${table.id} (metadata fetch failed): ${sanitizeBigQueryConnError(e)}`);
        }
      }
    }

    // BigQuery has no cross-table foreign-key enforcement exposed via this API surface.
    return { tables, columns, foreignKeys: [] };
  }

  /** Layer 1 (UX estimate): a `dryRun: true` job — never billed, never consumes
   *  query quota. Distinct from `explainQuery()`'s OLTP row-based shape; BigQuery
   *  cost is dollar-denominated via bytes scanned (Phase 3 architecture decision). */
  async estimateCost(sql: string): Promise<CostEstimate> {
    let jobResult;
    try {
      jobResult = await this.client.createQueryJob({ query: sql, dryRun: true });
    } catch (e) {
      throw new EstimateFailedError(e);
    }
    const job = jobResult[0];
    const rawBytes = Number(job.metadata?.statistics?.query?.totalBytesProcessed ?? 0);
    // A malformed/unexpected API response must not display as "$NaN" — treat it
    // the same as the 0-bytes blind spot (unreliable, floor-priced) rather than
    // let NaN propagate into a UI Phase 4 will render this into.
    const totalBytesProcessed = Number.isFinite(rawBytes) ? rawBytes : 0;
    const estimatedCostUsd = Math.max((totalBytesProcessed / BYTES_PER_TIB) * USD_PER_TIB, MIN_ESTIMATED_COST_USD);
    // The one documented dry-run blind spot (Phase 3 Requirements): 0 bytes for
    // a non-trivial query. A trivial query (e.g. `SELECT 1`) legitimately scans
    // 0 bytes, so this can under-flag — acceptable per Phase 3's scope decision,
    // since maximumBytesBilled (Layer 2) is the real backstop either way.
    const reliable = totalBytesProcessed > 0;
    return { estimatedBytes: totalBytesProcessed, estimatedCostUsd, reliable };
  }

  async executeReadOnly(sql: string, opts?: { timeoutMs?: number }): Promise<QueryResult> {
    let jobResult;
    try {
      jobResult = await this.client.createQueryJob({
        query: sql,
        maximumBytesBilled: String(this.config.maximumBytesBilled),
        ...(opts?.timeoutMs ? { jobTimeoutMs: opts.timeoutMs } : {}),
      });
    } catch (e) {
      if (isMaximumBytesBilledError(e)) throw new MaximumBytesBilledExceededError(e);
      throw new Error(sanitizeBigQueryConnError(e));
    }
    const job = jobResult[0];
    let rows;
    try {
      [rows] = await job.getQueryResults();
    } catch (e) {
      if (isMaximumBytesBilledError(e)) throw new MaximumBytesBilledExceededError(e);
      throw new Error(sanitizeBigQueryConnError(e));
    }
    const [metadata] = await job.getMetadata();
    const fields = (metadata.statistics?.query as { schema?: { fields?: { name: string }[] } } | undefined)?.schema?.fields
      ?? (rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>).map((name) => ({ name })) : []);
    const columns = fields.map((f) => f.name);
    const rowArrays = rows.map((r: Record<string, unknown>) => columns.map((c) => normalizeCell(r[c])));
    return { columns, rows: rowArrays, rowCount: rowArrays.length };
  }

  async explainQuery(_sql: string): Promise<never> {
    throw new Error('NotImplemented: BigQuery cost/blast-radius uses a dedicated dry-run + maximumBytesBilled mechanism (Phase 3), not EXPLAIN-based risk scoring.');
  }

  async close(): Promise<void> {
    // @google-cloud/bigquery has no pooled connection to release (HTTP-based client).
  }
}
