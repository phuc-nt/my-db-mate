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
};
