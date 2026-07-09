/**
 * Remote-HTTP provider (P4) — Cloudflare D1 over its REST API. D1 is SQLite, so
 * the safety-service SQLite dialect + denylist are reused unchanged; this provider
 * only changes HOW SQL reaches the DB (HTTPS + token instead of a local file).
 * Read-only is enforced by the safety layer upstream (D1's API has no read-only
 * flag), and D1 is often a replica/edge copy — pair with a read-scoped API token.
 */
import type {
  ConnectionProvider, Dialect, IntrospectedSchema, QueryResult, WritePrivilegeProbe, ExplainEstimate, ColumnInfo, ForeignKeyInfo,
} from './provider-interface';

export interface RemoteHttpConfig {
  accountId: string;
  databaseId: string;
  apiToken: string; // Cloudflare API token (secret — stored encrypted)
}

interface D1Response {
  result?: { results?: Record<string, unknown>[]; meta?: unknown }[];
  success: boolean;
  errors?: { message: string }[];
}

export class RemoteHttpProvider implements ConnectionProvider {
  readonly dialect: Dialect = 'sqlite';
  constructor(private readonly config: RemoteHttpConfig) {}

  private async d1(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/d1/database/${this.config.databaseId}/query`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    });
    const doc = (await res.json()) as D1Response;
    if (!doc.success) throw new Error(`D1 error: ${doc.errors?.map((e) => e.message).join('; ') ?? res.status}`);
    return doc.result?.[0]?.results ?? [];
  }

  async testConnection(): Promise<void> {
    await this.d1('SELECT 1');
  }

  async probeWritePrivilege(): Promise<WritePrivilegeProbe> {
    // D1 has no read-only handle; safety is enforced by the app safety layer.
    // Recommend a read-scoped Cloudflare API token. Report as "not verified read-only".
    return { isReadOnly: false, detail: 'D1 REST has no read-only mode; rely on the safety layer + a read-scoped API token.' };
  }

  async introspectSchema(): Promise<IntrospectedSchema> {
    const tableRows = await this.d1(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`);
    const columns: ColumnInfo[] = [];
    const foreignKeys: ForeignKeyInfo[] = [];
    for (const t of tableRows) {
      const tableName = String(t.name);
      const cols = await this.d1(`PRAGMA table_info("${tableName.replace(/"/g, '')}")`);
      for (const c of cols) {
        columns.push({ tableName, schemaName: null, columnName: String(c.name), dataType: String(c.type || 'unknown'), isNullable: Number(c.notnull) === 0, isPrimaryKey: Number(c.pk) > 0, ordinalPosition: Number(c.cid) });
      }
      const fks = await this.d1(`PRAGMA foreign_key_list("${tableName.replace(/"/g, '')}")`);
      for (const fk of fks) foreignKeys.push({ fromTable: tableName, fromColumn: String(fk.from), toTable: String(fk.table), toColumn: String(fk.to) });
    }
    // rowCount omitted for D1 remote — a COUNT(*) per table would be an extra
    // remote round-trip; the big-table guard simply has no estimate here (null).
    return { tables: tableRows.map((t) => ({ schemaName: null, tableName: String(t.name), rowCount: null })), columns, foreignKeys };
  }

  async executeReadOnly(sql: string): Promise<QueryResult> {
    const results = await this.d1(sql);
    const columns = results.length ? Object.keys(results[0]) : [];
    const rows = results.map((r) => columns.map((c) => r[c]));
    return { columns, rows, rowCount: rows.length };
  }

  async explainQuery(sql: string): Promise<ExplainEstimate> {
    const rows = await this.d1(`EXPLAIN QUERY PLAN ${sql}`);
    const details = rows.map((r) => String(r.detail ?? ''));
    const hasFullScan = details.some((d) => /\bSCAN\b/i.test(d) && !/USING (INDEX|COVERING INDEX|PRIMARY KEY)/i.test(d));
    const tableCount = new Set(details.map((d) => /(?:SCAN|SEARCH)\s+(\w+)/i.exec(d)?.[1]).filter(Boolean)).size;
    // raw is a remote HTTP response body → UNTRUSTED; the viewer renders it escaped.
    return { estimatedRows: null, estimatedCost: null, hasFullScan, tableCount, raw: details.join('\n') };
  }

  async close(): Promise<void> { /* stateless HTTP */ }
}
