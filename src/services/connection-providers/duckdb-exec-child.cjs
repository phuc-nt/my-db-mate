/**
 * DuckDB execution child process (plan D, red-team D1+D2).
 *
 * WHY a forked child: @duckdb/node-api runs queries on native threads that a
 * worker thread cannot interrupt; a forked child CAN be SIGKILL'd mid-query, so
 * a runaway scan/cross-join over a large file can't pin the app server's threads
 * or OOM it. Mirrors sqlite-exec-child.cjs.
 *
 * WHY ingest-then-lock (the security core): DuckDB replacement scans
 * (`SELECT * FROM '/etc/passwd'`) read files with NO function call, invisible to
 * any denylist. So the child:
 *   1. ingests the configured source file(s) into real in-memory TABLES while
 *      external access is still on,
 *   2. SET enable_external_access=false; SET lock_configuration=true  — locking
 *      the filesystem away from ALL subsequent SQL (verified by spike),
 *   3. only THEN runs the user's already-validated SELECT.
 * After the lock, read_csv / read_text / replacement scans / re-enabling access
 * all fail from the ENGINE — the denylist is only defense in depth.
 *
 * Plain .cjs so it loads without transpile under tsx/Next dev+prod;
 * @duckdb/node-api is a native module resolved like better-sqlite3.
 *
 * Message: { mode: 'query'|'introspect', source: {kind, path, tables}, sql? }
 *   source.kind: 'duckdb' | 'parquet' | 'csv-dir'
 *   source.tables: [{ name, path }]  (parquet/csv-dir: one entry per file)
 *   source.path: the .duckdb file (kind 'duckdb' only)
 */
const { DuckDBInstance } = require('@duckdb/node-api');

function esc(s) { return String(s).replace(/'/g, "''"); }
function quoteIdent(name) { return `"${String(name).replace(/"/g, '""')}"`; }

async function run(msg) {
  // A fresh in-memory instance per query — the child is short-lived and killed
  // after each call, so there is no cross-query state to leak.
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  const src = msg.source;
  if (src.kind === 'duckdb') {
    // Attach the user's .duckdb file READ-ONLY, then copy nothing — query it in
    // place. The attached DB's tables are the data; we still lock external access
    // after attach so user SQL can't reach OTHER files.
    await conn.run(`ATTACH '${esc(src.path)}' AS filedb (READ_ONLY)`);
    await conn.run(`USE filedb`);
  } else {
    // parquet / csv-dir: ingest each file into a real table WHILE external access
    // is on, so after the lock the data is present but the filesystem is gone.
    // Reader is chosen per file by extension (a csv-dir may hold .parquet too).
    for (const t of src.tables) {
      const reader = (t.kind === 'parquet' || src.kind === 'parquet') ? 'read_parquet' : 'read_csv_auto';
      await conn.run(`CREATE TABLE ${quoteIdent(t.name)} AS SELECT * FROM ${reader}('${esc(t.path)}')`);
    }
  }

  // LOCK: filesystem is now unreachable from user SQL (belt: denylist too).
  await conn.run('SET enable_external_access = false');
  await conn.run('SET lock_configuration = true');

  if (msg.mode === 'introspect') {
    const reader = await conn.runAndReadAll(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema NOT IN ('information_schema')
       ORDER BY table_name, ordinal_position`,
    );
    const rows = reader.getRows().map((r) => r.map(norm));
    // Row counts computed in the SAME locked session — the ingest already happened,
    // so this is cheap (no re-ingest per table, avoiding an O(N²) fan-out for the
    // parent that would otherwise run one full re-ingest per COUNT(*)).
    const tableNames = [...new Set(rows.map((r) => String(r[0])))];
    const counts = {};
    for (const t of tableNames) {
      try {
        const cr = await conn.runAndReadAll(`SELECT count(*) FROM "${t.replace(/"/g, '""')}"`);
        counts[t] = Number(norm(cr.getRows()[0][0]));
      } catch { counts[t] = null; }
    }
    return { ok: true, columns: reader.columnNames(), rows, counts };
  }

  const reader = await conn.runAndReadAll(msg.sql);
  const columns = reader.columnNames();
  const rows = reader.getRows().map((r) => r.map(norm));
  return { ok: true, columns, rows };
}

// DuckDB's node-api returns several non-JSON-serializable value types that would
// throw at the IPC boundary (process.send uses structured/JSON serialization):
//   - BIGINT / HUGEINT / UBIGINT → native `bigint`
//   - DECIMAL → DuckDBDecimalValue { value: bigint, scale, width }
//   - other DuckDBValue wrappers expose `.toString()` / `.toDouble()`
// Normalize every cell to a JSON-safe primitive. DECIMAL is converted to a number
// via value / 10^scale so a currency column reads as 500.0, not 500n.
function norm(v) {
  if (v == null) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object') {
    // DuckDBDecimalValue: { value: bigint, scale, width }
    if (typeof v.value === 'bigint' && typeof v.scale === 'number') {
      return Number(v.value) / Math.pow(10, v.scale);
    }
    // Other DuckDB value wrappers (dates, timestamps, etc.) — stringify safely.
    if (typeof v.toString === 'function' && v.constructor && v.constructor.name.startsWith('DuckDB')) {
      return v.toString();
    }
  }
  return v;
}

process.on('message', (msg) => {
  run(msg)
    .then((res) => { process.send(res); process.exit(0); })
    .catch((err) => { process.send({ ok: false, error: err instanceof Error ? err.message : String(err) }); process.exit(0); });
});
