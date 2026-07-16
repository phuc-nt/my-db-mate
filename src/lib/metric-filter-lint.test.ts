/**
 * Governed-metric adherence SQL-lint tests (Phase 1+2).
 *
 * Part A: Comparator unit tests — pure functions, no DB/LLM needed.
 * Part B: Lint-gate integration — invokes the real run_sql.execute (built via
 *   buildAgentTools) against a real SQLite connection, so the actual lint block
 *   (block / allow / far-bypass / bounded fail-open) is exercised, not re-implemented.
 *
 * Tests verify:
 * 1. extractGovernedFilterColumns extracts WHERE columns from metric SQL
 * 2. sqlFiltersColumn checks if agent SQL filters on a specific column
 * 3. missingGovernedFilters detects gaps when agent SQL drops metric's filters
 * 4. Fail-open behavior: unparseable SQL → no gap (don't block on parse failure)
 * 5. Tolerance: equivalent filter forms (IN vs =  OR) → no gap (column-presence only)
 * 6. Multi-column filters: partial gaps detected
 * 7. Filterless metrics: always no gap
 * 8. Dialect support: sqlite, postgres, (bigquery fail-open)
 * 9. Edge: metric filtering column in SELECT/GROUP BY (not WHERE) → still a gap
 * 10. Lint-gate integration: close metrics block missing filters; far metrics bypass lint
 * 11. Lint-gate fail-open: past retry cap → executes anyway (bounded self-correction)
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections } from '../db/schema';
import {
  extractGovernedFilterColumns,
  sqlFiltersColumn,
  missingGovernedFilters,
} from './metric-filter-lint';
import { buildAgentTools, type MatchedMetric } from '../services/agent-service';

// ===== PART A: COMPARATOR UNIT TESTS =====

describe('metric-filter-lint: comparators (Part A)', () => {
  describe('extractGovernedFilterColumns', () => {
    it('extracts columns from simple WHERE clause', () => {
      const sql = "SELECT COUNT(*) FROM orders WHERE ord_sts_cd IN ('S','D')";
      const cols = extractGovernedFilterColumns(sql, 'sqlite');
      expect(cols).toContain('ord_sts_cd');
    });

    it('extracts multiple columns from WHERE', () => {
      const sql = "SELECT COUNT(*) FROM orders WHERE status = 'active' AND region = 'EU'";
      const cols = extractGovernedFilterColumns(sql, 'postgres');
      expect(cols).toContain('status');
      expect(cols).toContain('region');
    });

    it('returns empty array for filterless metric', () => {
      const sql = 'SELECT COUNT(*) FROM orders';
      const cols = extractGovernedFilterColumns(sql, 'sqlite');
      expect(cols).toEqual([]);
    });

    it('returns empty array for unparseable metric SQL', () => {
      const sql = 'NOT SQL ((( invalid';
      const cols = extractGovernedFilterColumns(sql, 'sqlite');
      expect(cols).toEqual([]);
    });

    it('works with mysql dialect', () => {
      const sql = "SELECT COUNT(*) FROM orders WHERE cust_type = 'retail'";
      const cols = extractGovernedFilterColumns(sql, 'mysql');
      expect(cols).toContain('cust_type');
    });

    it('works with mssql dialect', () => {
      const sql = "SELECT COUNT(*) FROM orders WHERE region IN ('EMEA','APAC')";
      const cols = extractGovernedFilterColumns(sql, 'mssql');
      expect(cols).toContain('region');
    });

    it('bigquery dialect fails gracefully (returns empty array)', () => {
      // bigquery is not in DIALECT_MAP, so it defaults to PostgresQL parsing
      // and may fail gracefully. We assert it doesn't crash + returns a valid result.
      const sql = "SELECT COUNT(*) FROM orders WHERE status = 'shipped'";
      const cols = extractGovernedFilterColumns(sql, 'bigquery');
      expect(Array.isArray(cols)).toBe(true);
    });
  });

  describe('sqlFiltersColumn', () => {
    it('returns true when agent SQL filters on the column', () => {
      const agentSql = "SELECT * FROM orders WHERE ord_sts_cd = 'S'";
      const result = sqlFiltersColumn(agentSql, 'sqlite', 'ord_sts_cd');
      expect(result).toBe(true);
    });

    it('returns false when agent SQL does NOT filter on the column', () => {
      const agentSql = "SELECT * FROM orders WHERE customer_id = 123";
      const result = sqlFiltersColumn(agentSql, 'sqlite', 'ord_sts_cd');
      expect(result).toBe(false);
    });

    it('returns true (fail-open) for unparseable agent SQL', () => {
      const agentSql = 'NOT SQL ((( broken';
      const result = sqlFiltersColumn(agentSql, 'sqlite', 'ord_sts_cd');
      expect(result).toBe(true); // fail-open: assume filter is present
    });

    it('ignores column if it only appears in SELECT, not WHERE', () => {
      const agentSql = 'SELECT ord_sts_cd FROM orders WHERE customer_id = 123';
      const result = sqlFiltersColumn(agentSql, 'postgres', 'ord_sts_cd');
      expect(result).toBe(false); // column must be in WHERE, not just SELECT
    });

    it('ignores column if it only appears in GROUP BY, not WHERE', () => {
      const agentSql = 'SELECT ord_sts_cd, COUNT(*) FROM orders GROUP BY ord_sts_cd';
      const result = sqlFiltersColumn(agentSql, 'postgres', 'ord_sts_cd');
      expect(result).toBe(false); // column must be in WHERE
    });

    it('finds column in complex WHERE with AND', () => {
      const agentSql = "SELECT * FROM orders WHERE customer_id = 123 AND ord_sts_cd = 'S'";
      const result = sqlFiltersColumn(agentSql, 'sqlite', 'ord_sts_cd');
      expect(result).toBe(true);
    });

    it('finds column in complex WHERE with OR', () => {
      const agentSql = "SELECT * FROM orders WHERE ord_sts_cd = 'S' OR ord_sts_cd = 'D'";
      const result = sqlFiltersColumn(agentSql, 'postgres', 'ord_sts_cd');
      expect(result).toBe(true);
    });
  });

  describe('missingGovernedFilters', () => {
    it('detects gap when agent SQL drops metric filter', () => {
      const metricSql = "SELECT COUNT(*) FROM orders WHERE ord_sts_cd IN ('S','D')";
      const agentSql = 'SELECT COUNT(*) FROM orders';
      const gaps = missingGovernedFilters(agentSql, metricSql, 'sqlite');
      expect(gaps).toHaveLength(1);
      expect(gaps[0].column).toBe('ord_sts_cd');
    });

    it('returns empty array when agent SQL keeps metric filter (same form)', () => {
      const metricSql = "SELECT COUNT(*) FROM orders WHERE ord_sts_cd IN ('S','D')";
      const agentSql = "SELECT COUNT(*) FROM orders WHERE ord_sts_cd IN ('S','D')";
      const gaps = missingGovernedFilters(agentSql, metricSql, 'sqlite');
      expect(gaps).toEqual([]);
    });

    it('returns empty array when agent SQL keeps filter (equivalent form: = OR)', () => {
      const metricSql = "SELECT COUNT(*) FROM orders WHERE ord_sts_cd IN ('S','D')";
      const agentSql = "SELECT COUNT(*) FROM orders WHERE ord_sts_cd = 'S' OR ord_sts_cd = 'D'";
      const gaps = missingGovernedFilters(agentSql, metricSql, 'sqlite');
      expect(gaps).toEqual([]); // v1 tolerance: column-presence only, not exact form
    });

    it('detects partial gaps with multi-column filter', () => {
      const metricSql = "SELECT COUNT(*) FROM orders WHERE status = 'active' AND region = 'EU'";
      const agentSql = "SELECT COUNT(*) FROM orders WHERE status = 'active'";
      const gaps = missingGovernedFilters(agentSql, metricSql, 'postgres');
      expect(gaps).toHaveLength(1);
      expect(gaps[0].column).toBe('region');
    });

    it('detects all gaps with multi-column filter', () => {
      const metricSql = "SELECT COUNT(*) FROM orders WHERE status = 'active' AND region = 'EU' AND year = 2026";
      const agentSql = 'SELECT COUNT(*) FROM orders';
      const gaps = missingGovernedFilters(agentSql, metricSql, 'postgres');
      expect(gaps).toHaveLength(3);
      const cols = gaps.map((g) => g.column);
      expect(cols).toContain('status');
      expect(cols).toContain('region');
      expect(cols).toContain('year');
    });

    it('returns empty array for filterless metric', () => {
      const metricSql = 'SELECT COUNT(*) FROM orders';
      const agentSql = 'SELECT COUNT(*) FROM orders WHERE anything = 1';
      const gaps = missingGovernedFilters(agentSql, metricSql, 'sqlite');
      expect(gaps).toEqual([]);
    });

    it('returns empty array when unparseable metric SQL (fail-open)', () => {
      const metricSql = 'NOT SQL ((( broken';
      const agentSql = 'SELECT COUNT(*) FROM orders';
      const gaps = missingGovernedFilters(agentSql, metricSql, 'sqlite');
      expect(gaps).toEqual([]);
    });

    it('returns empty array when unparseable agent SQL (fail-open)', () => {
      const metricSql = "SELECT COUNT(*) FROM orders WHERE ord_sts_cd = 'S'";
      const agentSql = 'NOT SQL ((( broken';
      const gaps = missingGovernedFilters(agentSql, metricSql, 'sqlite');
      expect(gaps).toEqual([]);
    });

    it('works with postgres dialect', () => {
      const metricSql = "SELECT COUNT(*) FROM orders WHERE status IN ('shipped','delivered')";
      const agentSql = 'SELECT COUNT(*) FROM orders';
      const gaps = missingGovernedFilters(agentSql, metricSql, 'postgres');
      expect(gaps).toHaveLength(1);
      expect(gaps[0].column).toBe('status');
    });

    it('works with mysql dialect', () => {
      const metricSql = "SELECT COUNT(*) FROM orders WHERE order_type = 'retail'";
      const agentSql = 'SELECT COUNT(*) FROM orders';
      const gaps = missingGovernedFilters(agentSql, metricSql, 'mysql');
      expect(gaps).toHaveLength(1);
      expect(gaps[0].column).toBe('order_type');
    });

    it('returns empty array on bigquery dialect (no crash)', () => {
      const metricSql = "SELECT COUNT(*) FROM orders WHERE status = 'shipped'";
      const agentSql = 'SELECT COUNT(*) FROM orders';
      // bigquery defaults to PostgresQL parsing; should not crash
      const gaps = missingGovernedFilters(agentSql, metricSql, 'bigquery');
      expect(Array.isArray(gaps)).toBe(true);
    });
  });
});

// ===== PART B: LINT-GATE INTEGRATION (real run_sql.execute against a real connection) =====
// Drives the ACTUAL lint block in run_sql.execute (not a re-implementation): builds the
// tool with matched metrics, invokes run_sql.execute({sql}), and asserts the gate blocks/
// allows/bypasses/fails-open with a real SQLite connection so executeQuery runs for real
// when the lint passes. No LLM needed — run_sql.execute is a plain async function.

const LINT_DB_ROOT = path.join(process.cwd(), '.cache', 'metric-lint-test');

async function makeLintTestConnection(id: number): Promise<{ connId: string; dbPath: string }> {
  const dbPath = path.join(LINT_DB_ROOT, `lint${id}.db`);
  const sqlite = new Database(dbPath);
  sqlite.exec("CREATE TABLE orders (id INTEGER, ord_sts_cd TEXT); INSERT INTO orders VALUES (1,'S'),(2,'D'),(3,'X');");
  sqlite.close();
  const [row] = await db.insert(connections).values({
    name: `lint-test-${id}`, kind: 'sqlite-file', dialect: 'sqlite',
    config: { path: dbPath }, secretEncrypted: null, isReadOnlyVerified: true,
  }).returning();
  return { connId: row.id, dbPath };
}

/** Grab the real run_sql tool bound to a connection + matched metrics, and return a
 *  caller that invokes its execute (the AI SDK passes (args, context) — context is
 *  unused by run_sql.execute, so a stub is fine). */
function runSqlExec(connId: string, matched: MatchedMetric[]) {
  const tools = buildAgentTools(connId, 'owner', undefined, 'chat', 'sqlite', matched);
  const exec = (tools as Record<string, { execute: unknown }>).run_sql.execute as
    (a: { sql: string }, ctx: unknown) => Promise<Record<string, unknown>>;
  return (sql: string) => exec({ sql }, { toolCallId: 't', messages: [] });
}

const CLOSE = 0.1;   // within LINT_DISTANCE_FLOOR (0.2)
const FAR = 0.3;     // beyond it
const GOVERNED = "SELECT COUNT(*) FROM orders WHERE ord_sts_cd IN ('S','D')";

describe('metric-filter-lint: lint-gate integration (Part B, real run_sql)', () => {
  const conns: string[] = [];
  const paths: string[] = [];

  beforeAll(async () => {
    await rm(LINT_DB_ROOT, { recursive: true, force: true });
    await mkdir(LINT_DB_ROOT, { recursive: true });
  });
  afterEach(async () => {
    for (const c of conns) await db.delete(connections).where(eq(connections.id, c));
    for (const p of paths) await rm(p, { force: true });
    conns.length = 0; paths.length = 0;
  });

  async function conn(id: number) {
    const c = await makeLintTestConnection(id);
    conns.push(c.connId); paths.push(c.dbPath);
    return c.connId;
  }

  it('close-matched metric + agent SQL missing the governed filter → blocked (no DB execution)', async () => {
    const connId = await conn(1);
    const exec = runSqlExec(connId, [{ name: 'Order count', sql: GOVERNED, distance: CLOSE }]);
    const res = await exec('SELECT COUNT(*) FROM orders'); // dropped the filter
    expect(res.governedFilterMissing).toBe(true);
    expect(res.missingColumns).toContain('ord_sts_cd');
    expect(res.rows).toBeUndefined();          // did NOT execute
    expect(res.governedFilterHint).toBeDefined();
  });

  // "lint passed" = the tool result is NOT the governedFilterMissing early-return; it
  // fell through to executeQuery (whose result may be rows OR the risk-gate's
  // needsConfirmation for a full-scan — both mean the lint did not block).
  const lintPassed = (r: Record<string, unknown>) =>
    r.governedFilterMissing === undefined && (r.rows !== undefined || r.needsConfirmation === true);

  it('close-matched metric + agent SQL that KEEPS the filter → not linted (falls through to execute)', async () => {
    const connId = await conn(2);
    const exec = runSqlExec(connId, [{ name: 'Order count', sql: GOVERNED, distance: CLOSE }]);
    const res = await exec("SELECT COUNT(*) AS n FROM orders WHERE ord_sts_cd IN ('S','D')");
    expect(lintPassed(res)).toBe(true);
  });

  it('FAR-matched metric (distance > LINT_DISTANCE_FLOOR) → NOT linted, falls through even without the filter', async () => {
    const connId = await conn(3);
    const exec = runSqlExec(connId, [{ name: 'Order count', sql: GOVERNED, distance: FAR }]);
    const res = await exec('SELECT COUNT(*) FROM orders');
    expect(lintPassed(res)).toBe(true);        // far metric doesn't enforce
  });

  it('no matched metrics → never linted (regression: default behavior unchanged)', async () => {
    const connId = await conn(4);
    const exec = runSqlExec(connId, []);
    const res = await exec('SELECT COUNT(*) FROM orders');
    expect(lintPassed(res)).toBe(true);
  });

  it('bounded fail-open: after the retry cap, a filter-dropping query is no longer linted (no infinite loop)', async () => {
    const connId = await conn(5);
    const exec = runSqlExec(connId, [{ name: 'Order count', sql: GOVERNED, distance: CLOSE }]);
    const dropped = 'SELECT COUNT(*) FROM orders';
    // Same tool instance keeps state.consecutiveFailures across calls (per-turn closure).
    const r1 = await exec(dropped);
    expect(r1.governedFilterMissing).toBe(true);   // cf 0→1, blocked
    const r2 = await exec(dropped);
    expect(r2.governedFilterMissing).toBe(true);   // cf 1→2, blocked (with stopRetrying)
    const r3 = await exec(dropped);
    expect(r3.governedFilterMissing).toBeUndefined(); // cap reached → lint no longer fires (fail-open)
    expect(lintPassed(r3)).toBe(true);
  });
});
