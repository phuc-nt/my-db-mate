/**
 * Result export formats (P9-A4). CSV (with formula-injection guard), JSON, and
 * dialect-aware SQL-INSERT. The SQL-INSERT is meant to be run by the user in their
 * own client, so literals are escaped per the TARGET dialect (red-team M2 — a
 * SQLite round-trip does not prove PG/MySQL safety).
 */
export type ExportDialect = 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'duckdb';

/** Guard against CSV formula injection: a cell starting with = + - @ is prefixed
 *  with a single quote so spreadsheet apps don't execute it as a formula. */
function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  const head = columns.map(csvCell).join(',');
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  return `${head}\n${body}`;
}

export function toJson(columns: string[], rows: unknown[][]): string {
  const objs = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
  return JSON.stringify(objs, null, 2);
}

/** Quote a table/column identifier for the target dialect. */
function quoteIdent(name: string, dialect: ExportDialect): string {
  const safe = name.replace(/[^A-Za-z0-9_]/g, '');
  if (dialect === 'mysql') return `\`${safe}\``;
  if (dialect === 'mssql') return `[${safe}]`;
  return `"${safe}"`;
}

/** Escape a value as a SQL literal for the target dialect. */
function sqlLiteral(v: unknown, dialect: ExportDialect): string {
  if (v == null) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return dialect === 'postgres' ? (v ? 'TRUE' : 'FALSE') : (v ? '1' : '0'); // mssql/mysql/sqlite use 1/0
  const s = String(v);
  // Double single-quotes for all three. MySQL also treats backslash as an escape
  // char by default, so escape it too for the MySQL target.
  const escaped = dialect === 'mysql'
    ? s.replace(/\\/g, '\\\\').replace(/'/g, "''")
    : s.replace(/'/g, "''");
  return `'${escaped}'`;
}

export function toSqlInsert(columns: string[], rows: unknown[][], dialect: ExportDialect, tableName = 'exported_table'): string {
  const cols = columns.map((c) => quoteIdent(c, dialect)).join(', ');
  const table = quoteIdent(tableName, dialect);
  const lines = rows.map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v) => sqlLiteral(v, dialect)).join(', ')});`);
  return lines.join('\n');
}

/** Trigger a browser download of a text blob. */
export function downloadText(text: string, filename: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
