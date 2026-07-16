/** Build a dialect-correct, safe table reference for raw SQL.
 *
 *  BigQuery REQUIRES a table to be qualified with its dataset (`dataset.table`) —
 *  a bare table name is rejected by the query planner ("Table must be qualified
 *  with a dataset"). Other dialects resolve a bare name against the default schema,
 *  so we keep the historical bare-name quoting for them (qualifying could break an
 *  OLTP query that relies on the search_path/default schema).
 *
 *  `schemaName` is the dataset id for BigQuery (from schemaTables.schemaName during
 *  introspection). Identifiers are stripped to a safe charset before quoting. */
export function qualifiedTableRef(dialect: string, tableName: string, schemaName?: string | null): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '');
  const t = safe(tableName);
  if (dialect === 'bigquery') {
    // BigQuery uses backtick-quoting; qualify with the dataset when known.
    return schemaName ? `\`${safe(schemaName)}\`.\`${t}\`` : `\`${t}\``;
  }
  if (dialect === 'mysql') return `\`${t}\``;
  if (dialect === 'mssql') return `[${t}]`;
  return `"${t}"`;
}

/** Column identifier quoting (never dataset-qualified — a column is referenced by
 *  name within the FROM'd table). */
export function quoteColumn(dialect: string, columnName: string): string {
  const safe = columnName.replace(/[^A-Za-z0-9_]/g, '');
  if (dialect === 'bigquery' || dialect === 'mysql') return `\`${safe}\``;
  if (dialect === 'mssql') return `[${safe}]`;
  return `"${safe}"`;
}
