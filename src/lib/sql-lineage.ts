/** One-line lineage extracted from a SELECT's AST: which tables it reads, which
 *  columns it filters on, and what it groups by. Server-side only (node-sql-parser
 *  is heavy — never import from client components; ship the result as data).
 *  Parse failures return null — show nothing rather than guess. */
import pkg from 'node-sql-parser';
const { Parser } = pkg;

export interface SqlLineage {
  tables: string[];
  whereColumns: string[];
  groupBy: string[];
}

const DIALECT_MAP: Record<string, string> = {
  postgres: 'PostgresQL',
  mysql: 'MySQL',
  sqlite: 'Sqlite',
  mssql: 'TransactSQL',
};

/** Collect column refs from a WHERE-expression tree. */
function collectColumns(node: unknown, out: Set<string>) {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (n.type === 'column_ref') {
    // node-sql-parser: column may be a string or { expr: { value } }.
    const col = typeof n.column === 'string' ? n.column
      : (n.column as { expr?: { value?: string } } | undefined)?.expr?.value;
    if (col) out.add(String(col));
    return;
  }
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) v.forEach((x) => collectColumns(x, out));
    else if (v && typeof v === 'object') collectColumns(v, out);
  }
}

export function extractLineage(sql: string, dialect: string): SqlLineage | null {
  try {
    const parser = new Parser();
    const ast = parser.astify(sql, { database: DIALECT_MAP[dialect] ?? 'PostgresQL' });
    const stmt = Array.isArray(ast) ? ast[0] : ast;
    if (!stmt || (stmt as { type?: string }).type !== 'select') return null;
    const sel = stmt as unknown as {
      from?: { table?: string | null }[] | null;
      where?: unknown;
      groupby?: { columns?: unknown[] } | unknown[] | null;
    };

    const tables = [...new Set((sel.from ?? []).map((f) => f.table).filter((t): t is string => !!t))];

    const whereCols = new Set<string>();
    if (sel.where) collectColumns(sel.where, whereCols);

    const groupBy = new Set<string>();
    const gb = Array.isArray(sel.groupby) ? sel.groupby : (sel.groupby as { columns?: unknown[] } | null)?.columns;
    if (Array.isArray(gb)) gb.forEach((g) => collectColumns(g, groupBy));

    if (tables.length === 0) return null;
    return { tables, whereColumns: [...whereCols].slice(0, 6), groupBy: [...groupBy].slice(0, 6) };
  } catch {
    return null;
  }
}
