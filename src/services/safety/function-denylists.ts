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
};
