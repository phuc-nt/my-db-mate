/**
 * Per-dialect denylist of side-effecting / admin / exfiltration functions and
 * constructs (RT-F1). A read-only transaction does NOT block these — many are
 * SELECT-legal (pg_terminate_backend, pg_read_file, COPY...TO, load_extension),
 * so we walk the SQL for them explicitly.
 *
 * Matching is case-insensitive on whole-word tokens.
 */
import type { Dialect } from '../connection-providers/provider-interface';

/** Function names / keywords that must never appear in an allowed query. */
export const FUNCTION_DENYLIST: Record<Dialect, string[]> = {
  postgres: [
    'pg_terminate_backend',
    'pg_cancel_backend',
    'pg_sleep',
    'pg_sleep_for',
    'pg_read_file',
    'pg_read_binary_file',
    'pg_ls_dir',
    'pg_stat_file',
    'lo_export',
    'lo_import',
    'dblink',
    'dblink_exec',
    'dblink_connect',
    'copy', // COPY ... TO PROGRAM / FROM PROGRAM
  ],
  mysql: [
    'sleep',
    'benchmark',
    'get_lock',
    'load_file',
    'sys_exec',
    'sys_eval',
  ],
  sqlite: [
    'load_extension',
    'readfile',
    'writefile',
    'edit',
    'fts3_tokenizer',
  ],
  mssql: [
    // Command execution / OLE automation.
    'xp_cmdshell',
    'sp_oacreate',
    'sp_oamethod',
    'sp_oagetproperty',
    'sp_execute_external_script',
    // Dynamic SQL — string execution bypasses the AST check entirely.
    'exec',
    'execute',
    'sp_executesql',
    // Cross-source / file access.
    'openrowset',
    'openquery',
    'opendatasource',
    'openxml',
    // Registry / filesystem extended procs.
    'xp_regread',
    'xp_regwrite',
    'xp_regdeletevalue',
    'xp_dirtree',
    'xp_fileexist',
    'xp_subdirs',
    // Config / DoS.
    'sp_configure',
    'reconfigure',
    'waitfor', // WAITFOR DELAY/TIME — the T-SQL analogue of pg_sleep
  ],
  // BigQuery connections never call validateSql() — cost-safety (dry-run estimate +
  // maximumBytesBilled) is a dedicated mechanism, not the OLTP denylist/row-cap screen
  // (see Phase 3 of the BigQuery connector plan). Empty, not a real per-dialect list.
  bigquery: [],
  // DuckDB (file connections). DEFENSE IN DEPTH ONLY — the real filesystem boundary
  // is the engine lockdown the provider applies before any user SQL runs
  // (enable_external_access=false + lock_configuration=true, verified by spike). A
  // denylist can't catch a DuckDB REPLACEMENT SCAN (`SELECT * FROM '/etc/passwd'`
  // has no function call), which is exactly why the engine lock is primary. These
  // block the obvious file/extension/config functions so a lock regression degrades
  // gracefully rather than silently.
  duckdb: [
    // File readers (all the aliases a name-check can see).
    'read_csv', 'read_csv_auto', 'csv_scan',
    'read_parquet', 'parquet_scan',
    'read_json', 'read_json_auto', 'read_ndjson', 'read_ndjson_auto', 'read_json_objects',
    'read_text', 'read_blob', 'sniff_csv', 'glob',
    // Env / system introspection.
    'getenv',
    // Extension + external database attach as function-style (belt; phrases below too).
    'load_extension', 'install_extension',
  ],
};

/**
 * Multi-word / phrase constructs that a function-name check misses (e.g.
 * `INTO OUTFILE`, `SET ... READ WRITE`). Checked as regexes on normalized SQL.
 */
export const PHRASE_DENYLIST: Record<Dialect, RegExp[]> = {
  postgres: [
    /\bset\b[\s\S]*\btransaction\b[\s\S]*\bread\s+write\b/i,
    /\bset\b[\s\S]*\bdefault_transaction_read_only\b/i,
    /\bcopy\b[\s\S]*\bto\b/i,
    /\bcopy\b[\s\S]*\bprogram\b/i,
  ],
  mysql: [
    /\binto\s+outfile\b/i,
    /\binto\s+dumpfile\b/i,
    /\bset\b[\s\S]*\btransaction\b[\s\S]*\bread\s+write\b/i,
  ],
  sqlite: [
    /\battach\s+database\b/i,
    /\bdetach\s+database\b/i,
    /\bpragma\b/i, // block PRAGMA outright in user queries (writes/config)
  ],
  mssql: [
    // SELECT ... INTO <table> creates+populates a table (a write) yet parses as a
    // SELECT — backstop to the AST `into.expr` check in safety-service.
    /\bselect\b[\s\S]*?\binto\s+[[\w#@]/i,
    // BULK INSERT reads a server-side file into a table.
    /\bbulk\s+insert\b/i,
    // 4-part linked-server reference (server.db.schema.table) queries another
    // server and bypasses OPENQUERY/OPENROWSET screening. Each part may be a bare
    // word, a [bracketed] or "quoted" identifier, with optional surrounding spaces.
    /\bfrom\s+(\[[^\]]+\]|"[^"]+"|\w+)\s*\.\s*(\[[^\]]+\]|"[^"]+"|\w*)\s*\.\s*(\[[^\]]+\]|"[^"]+"|\w*)\s*\.\s*(\[[^\]]+\]|"[^"]+"|\w)/i,
    // FOR XML can shape data for exfiltration; block defensively (FOR JSON is fine).
    /\bfor\s+xml\b/i,
    // GO batch separator — not valid inside a single statement, block defensively.
    /(^|\n)\s*go\s*($|\n)/i,
  ],
  // DuckDB phrase constructs a function-name check misses. Again defense-in-depth
  // behind the engine lockdown — these block the statement forms that change config,
  // load extensions, attach databases, or write/export files.
  duckdb: [
    /\binstall\b/i,          // INSTALL <extension>
    /\bload\b/i,             // LOAD <extension>
    /\battach\b/i,           // ATTACH '<db>' / ATTACH DATABASE
    /\bdetach\b/i,
    /\bcopy\b[\s\S]*\bto\b/i, // COPY ... TO '<file>' (write/export)
    /\bexport\s+database\b/i,
    /\bimport\s+database\b/i,
    /\bpragma\b/i,           // PRAGMA changes engine config
    /\b(set|reset)\b/i,      // SET enable_external_access / lock_configuration etc.
    /\bcreate\b/i,           // no DDL from user SQL (tables are provider-ingested)
    /\binstall\s+extension\b/i,
  ],
  // See FUNCTION_DENYLIST.bigquery above — BigQuery never reaches this screen.
  bigquery: [],
};
