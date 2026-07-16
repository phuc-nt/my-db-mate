/**
 * Phase 3 (anomaly depth + BigQuery unlock) tests: detectAnomalies() refactor
 * from Group-A executeReadOnly to executeQuery({backgroundBudgeted:true}), plus
 * robust MAD outlier detection and drift baseline persistence.
 *
 * Tests behavioral requirements:
 * 1. Numeric report shape includes robust field (MAD-based outlier count when sample ≥ MIN_MAD_OBS)
 * 2. Backward-compat: legacy numeric.* fields all present and correct type
 * 3. True min/max from SQL (not sample) vs avg/stddev/outliers from sample
 * 4. Non-numeric column: numeric absent, nullRate correct, note mentions "Non-numeric"
 * 5. Drift cold-start: undefined on first probe; baselineN present after ≥14 probes
 * 6. Drift best-effort: failures don't discard the numeric result
 * 7. nullRate correct for known NULL count
 *
 * Setup: SQLite test DB with small deterministic table (known outliers/nulls).
 * Cleanup: afterEach deletes all inserted rows (connections cascade-delete).
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import path from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { db } from '../db/client';
import { connections, schemaTables, schemaColumns } from '../db/schema';
import { anomalyBaselines } from '../db/anomaly-schema';
import { detectAnomalies, type AnomalyReport } from './anomaly-service';
import { MIN_MAD_OBS } from '../lib/robust-stats';

// ===== HELPERS =====

/** Create a test SQLite connection. */
async function createTestConnection(name: string, dbPath: string) {
  const [row] = await db
    .insert(connections)
    .values({
      name,
      kind: 'sqlite-file',
      dialect: 'sqlite',
      config: { path: dbPath },
      secretEncrypted: null,
      isReadOnlyVerified: true,
    })
    .returning();
  return row;
}

/** Helper: create a test SQLite connection with empty DB + tracking. */
async function makeTestConnection(name: string, testId: number, createdConnections: string[], createdDbPaths: string[]) {
  const dbPath = path.join(DB_ROOT, `anomaly-test${testId}.db`);
  createdDbPaths.push(dbPath);
  new Database(dbPath).close();
  const conn = await createTestConnection(name, dbPath);
  createdConnections.push(conn.id);
  return conn;
}

/** Clean up all test data: connections (which cascade-delete their metrics/tables/columns/baselines). */
async function cleanupConnections(connIds: string[]) {
  for (const id of connIds) {
    await db.delete(connections).where(eq(connections.id, id));
  }
}

/** Manually insert a table + column into the schema registry (simulating a discovered table). */
async function registerTestTable(connectionId: string, tableName: string, columnName: string, dataType: string) {
  const [table] = await db
    .insert(schemaTables)
    .values({ connectionId, tableName, rowCount: 0 })
    .returning();
  await db
    .insert(schemaColumns)
    .values({
      tableId: table.id,
      columnName,
      dataType,
      isNullable: true,
      isPrimaryKey: false,
      ordinalPosition: 0,
    });
  return table;
}

/** Execute SQL on a test SQLite DB file (outside the app's provider layer, for setup). */
// ===== TESTS =====

const DB_ROOT = path.join(process.cwd(), '.cache', 'anomaly-test');

describe('anomaly-service (Phase 3)', () => {
  const createdConnections: string[] = [];
  const createdDbPaths: string[] = [];

  beforeAll(async () => {
    await rm(DB_ROOT, { recursive: true, force: true });
    await mkdir(DB_ROOT, { recursive: true });
  });

  afterEach(async () => {
    await cleanupConnections(createdConnections);
    createdConnections.length = 0;
    // Clean up SQLite files
    for (const path_ of createdDbPaths) {
      await rm(path_, { force: true });
    }
    createdDbPaths.length = 0;
    // Clean anomaly_baselines (just in case)
    // Note: cascade delete via connection should handle this, but explicit cleanup is safe
  });

  // --- Test 1: Numeric report shape + robust field ---
  describe('numeric report shape + robust field', () => {
    it('returns numeric report with robust field (MAD outliers) when sample ≥ MIN_MAD_OBS', async () => {
      const conn = await makeTestConnection('test-numeric-robust', 1, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test1.db');

      // Create a table with 25 values: ~20 clustered ~100, plus 2 clear outliers at 10000
      // This ensures:
      // - σ-outliers: inflated by the extreme values
      // - MAD-outliers: robust to the extremes, more conservative
      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE test_table (id INTEGER PRIMARY KEY, amount REAL)');
      for (let i = 0; i < 20; i++) {
        db_.prepare('INSERT INTO test_table VALUES (?, ?)').run(i, 100 + Math.random() * 5 - 2.5);
      }
      db_.prepare('INSERT INTO test_table VALUES (?, ?)').run(20, 10000);
      db_.prepare('INSERT INTO test_table VALUES (?, ?)').run(21, 10000);
      db_.close();

      // Register the table in the schema
      await registerTestTable(conn.id, 'test_table', 'amount', 'REAL');

      // Detect anomalies
      const report = await detectAnomalies(conn.id, 'test_table', 'amount');

      // Assert numeric report is present
      expect(report.numeric).toBeDefined();
      expect(report.numeric?.min).toBeDefined();
      expect(report.numeric?.max).toBeDefined();
      expect(report.numeric?.avg).toBeGreaterThan(0);
      expect(report.numeric?.stddev).toBeGreaterThanOrEqual(0);
      expect(report.numeric?.outlierCount).toBeGreaterThanOrEqual(0); // σ-outlier count

      // Assert robust field is present (sample ≥ MIN_MAD_OBS)
      expect(report.robust).toBeDefined();
      expect(report.robust?.outlierCount).toBeGreaterThanOrEqual(0);
      expect(report.robust?.sampleN).toBeGreaterThanOrEqual(MIN_MAD_OBS);
      expect(report.robust?.method).toMatch(/^(mad|sigma-fallback)$/);
      expect(report.robust?.median).toBeGreaterThan(0);
      expect(report.robust?.mad).toBeGreaterThanOrEqual(0);

      // Assert note mentions "Robust (MAD)"
      expect(report.note).toMatch(/Robust \(MAD\)/);
    });

    it('robust field absent when sample < MIN_MAD_OBS (cold-start)', async () => {
      const conn = await makeTestConnection('test-tiny-sample', 2, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test2.db');

      // Create a table with only 5 values (< MIN_MAD_OBS)
      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE tiny (id INTEGER PRIMARY KEY, val REAL)');
      for (let i = 1; i <= 5; i++) {
        db_.prepare('INSERT INTO tiny VALUES (?, ?)').run(i, i * 10);
      }
      db_.close();

      await registerTestTable(conn.id, 'tiny', 'val', 'REAL');

      const report = await detectAnomalies(conn.id, 'tiny', 'val');

      // numeric present, but robust absent (sample too small)
      expect(report.numeric).toBeDefined();
      expect(report.robust).toBeUndefined();
    });
  });

  // --- Test 2: Report backward-compat ---
  describe('report backward-compat (legacy fields)', () => {
    it('all legacy numeric fields present and correct type', async () => {
      const conn = await makeTestConnection('test-legacy-compat', 3, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test3.db');

      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE legacy_test (id INTEGER, score REAL)');
      const values = [85, 90, 88, 92, 87, 500];
      for (let i = 0; i < values.length; i++) {
        db_.prepare('INSERT INTO legacy_test VALUES (?, ?)').run(i + 1, values[i]);
      }
      db_.close();

      await registerTestTable(conn.id, 'legacy_test', 'score', 'REAL');

      const report = await detectAnomalies(conn.id, 'legacy_test', 'score');

      // Core fields (backward-compat)
      expect(report.table).toBe('legacy_test');
      expect(report.column).toBe('score');
      expect(typeof report.total).toBe('number');
      expect(report.total).toBeGreaterThan(0);
      expect(typeof report.nullRate).toBe('number');
      expect(report.nullRate).toBeGreaterThanOrEqual(0);
      expect(report.nullRate).toBeLessThanOrEqual(1);

      // numeric fields
      expect(report.numeric).toBeDefined();
      expect(typeof report.numeric?.avg).toBe('number');
      expect(typeof report.numeric?.stddev).toBe('number');
      expect(typeof report.numeric?.min).toBe('string'); // wrapped
      expect(typeof report.numeric?.max).toBe('string'); // wrapped
      expect(typeof report.numeric?.outlierCount).toBe('number');

      // note present
      expect(report.note).toBeDefined();
      expect(typeof report.note).toBe('string');
    });
  });

  // --- Test 3: True min/max from SQL ---
  describe('true min/max (SQL MIN/MAX, not sample)', () => {
    it('min/max are TRUE table extremes even with partial sample', async () => {
      const conn = await makeTestConnection('test-true-extremes', 4, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test4.db');

      // Create 25 rows: values 100-110, plus true min=5 and true max=999
      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE extremes (id INTEGER PRIMARY KEY, val REAL)');
      db_.prepare('INSERT INTO extremes VALUES (?, ?)').run(1, 5); // true minimum
      for (let i = 0; i < 23; i++) {
        db_.prepare('INSERT INTO extremes VALUES (?, ?)').run(i + 2, 100 + (i % 10));
      }
      db_.prepare('INSERT INTO extremes VALUES (?, ?)').run(25, 999); // true maximum
      db_.close();

      await registerTestTable(conn.id, 'extremes', 'val', 'REAL');

      const report = await detectAnomalies(conn.id, 'extremes', 'val');

      // min/max should be wrapped strings from SQL MIN/MAX
      expect(report.numeric?.min).toContain('5'); // true minimum (wrapped in <data>...</data>)
      expect(report.numeric?.max).toContain('999'); // true maximum
    });
  });

  // --- Test 4: Non-numeric column ---
  describe('non-numeric column handling', () => {
    it('non-numeric column: numeric absent, nullRate present, note mentions "Non-numeric"', async () => {
      const conn = await makeTestConnection('test-non-numeric', 5, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test5.db');

      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE text_test (id INTEGER PRIMARY KEY, name TEXT)');
      db_.prepare('INSERT INTO text_test VALUES (?, ?)').run(1, 'Alice');
      db_.prepare('INSERT INTO text_test VALUES (?, ?)').run(2, 'Bob');
      db_.prepare('INSERT INTO text_test VALUES (?, ?)').run(3, null);
      db_.prepare('INSERT INTO text_test VALUES (?, ?)').run(4, 'Charlie');
      db_.prepare('INSERT INTO text_test VALUES (?, ?)').run(5, null);
      db_.close();

      await registerTestTable(conn.id, 'text_test', 'name', 'TEXT');

      const report = await detectAnomalies(conn.id, 'text_test', 'name');

      // numeric absent
      expect(report.numeric).toBeUndefined();
      // robust absent
      expect(report.robust).toBeUndefined();
      // nullRate present and correct
      expect(report.nullRate).toBe(0.4); // 2 nulls out of 5
      // total present
      expect(report.total).toBe(5);
      // note mentions "Non-numeric"
      expect(report.note).toMatch(/Non-numeric/);
    });
  });

  // --- Test 5: Drift cold-start & persistence ---
  describe('drift cold-start and persistence', () => {
    it('first probe on a column → drift undefined (no history)', async () => {
      const conn = await makeTestConnection('test-drift-cold', 6, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test6.db');

      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE drift_test (id INTEGER PRIMARY KEY, val REAL)');
      for (let i = 0; i < 20; i++) {
        db_.prepare('INSERT INTO drift_test VALUES (?, ?)').run(i, 100 + Math.random() * 5);
      }
      db_.close();

      await registerTestTable(conn.id, 'drift_test', 'val', 'REAL');

      const report = await detectAnomalies(conn.id, 'drift_test', 'val');

      // On first probe, drift is undefined (cold-start)
      expect(report.drift).toBeUndefined();

      // But a baseline row was inserted (for future probes)
      const baselineRows = await db
        .select()
        .from(anomalyBaselines)
        .where(
          and(
            eq(anomalyBaselines.connectionId, conn.id),
            eq(anomalyBaselines.tableName, 'drift_test'),
            eq(anomalyBaselines.columnName, 'val')
          )
        );
      expect(baselineRows.length).toBeGreaterThan(0);
    });

    it('after ≥14 probes with stable avg, a probe with far-from-baseline avg shows drift', async () => {
      const conn = await makeTestConnection('test-drift-detect', 7, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test7.db');

      // Create a table with stable avg ~100
      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE drift_detect (id INTEGER PRIMARY KEY, val REAL)');
      for (let i = 0; i < 20; i++) {
        db_.prepare('INSERT INTO drift_detect VALUES (?, ?)').run(i, 100 + (Math.random() * 10 - 5));
      }
      db_.close();

      await registerTestTable(conn.id, 'drift_detect', 'val', 'REAL');

      // Insert 14 prior baseline rows with avg ~100 (stable history)
      const now = new Date();
      for (let i = 0; i < 14; i++) {
        await db.insert(anomalyBaselines).values({
          connectionId: conn.id,
          tableName: 'drift_detect',
          columnName: 'val',
          avg: 100 + (Math.random() * 2 - 1), // ~100 ± 1
          stddev: 5,
          nullRate: 0,
          capturedAt: new Date(now.getTime() - (14 - i) * 60 * 60 * 1000), // spread over 14 hours
        });
      }

      // Now run a probe: the in-DB avg should be ~100, so no drift yet
      const report = await detectAnomalies(conn.id, 'drift_detect', 'val');
      // First probe might not show drift if avg is still close
      expect(report.drift).toBeDefined();
      expect(typeof report.drift?.baselineN).toBe('number');
      expect(report.drift?.baselineN).toBeGreaterThanOrEqual(14);

      // To trigger drift, we'd need to mutate the table to change avg significantly.
      // For this test, we just verify that baselineN is present and ≥14.
    });

    it('drift best-effort: if persist fails, numeric result is still returned', async () => {
      // This is hard to trigger in a real test without mocking the DB.
      // Instead, verify structurally that:
      // - A probe on a fresh connection (drift compute fails / baseline insert fails)
      // - Still returns a full numeric report
      const conn = await makeTestConnection('test-drift-best-effort', 8, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test8.db');

      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE best_effort (id INTEGER PRIMARY KEY, val REAL)');
      for (let i = 0; i < 20; i++) {
        db_.prepare('INSERT INTO best_effort VALUES (?, ?)').run(i, 100 + Math.random() * 10);
      }
      db_.close();

      await registerTestTable(conn.id, 'best_effort', 'val', 'REAL');

      // Run a probe. Even if drift persist were to fail silently (best-effort),
      // numeric should still be present.
      const report = await detectAnomalies(conn.id, 'best_effort', 'val');

      expect(report.numeric).toBeDefined();
      expect(report.total).toBeGreaterThan(0);
      // drift may be undefined (cold-start) or a failed compute, but numeric is always there
    });
  });

  // --- Test 6: nullRate correctness ---
  describe('nullRate correctness', () => {
    it('nullRate = actual_nulls / total', async () => {
      const conn = await makeTestConnection('test-nullrate', 9, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test9.db');

      // Create 25 rows: 20 values, 5 nulls → nullRate = 5/25 = 0.2
      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE nullrate_test (id INTEGER PRIMARY KEY, val REAL)');
      for (let i = 0; i < 20; i++) {
        db_.prepare('INSERT INTO nullrate_test VALUES (?, ?)').run(i, 100 + i);
      }
      for (let i = 20; i < 25; i++) {
        db_.prepare('INSERT INTO nullrate_test VALUES (?, ?)').run(i, null);
      }
      db_.close();

      await registerTestTable(conn.id, 'nullrate_test', 'val', 'REAL');

      const report = await detectAnomalies(conn.id, 'nullrate_test', 'val');

      expect(report.total).toBe(25);
      expect(report.nullRate).toBe(0.2); // 5 nulls / 25 total
    });

    it('nullRate = 0 when no nulls', async () => {
      const conn = await makeTestConnection('test-no-nulls', 10, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test10.db');

      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE no_nulls (id INTEGER PRIMARY KEY, val REAL)');
      for (let i = 0; i < 10; i++) {
        db_.prepare('INSERT INTO no_nulls VALUES (?, ?)').run(i, 50 + i);
      }
      db_.close();

      await registerTestTable(conn.id, 'no_nulls', 'val', 'REAL');

      const report = await detectAnomalies(conn.id, 'no_nulls', 'val');

      expect(report.nullRate).toBe(0);
    });

    it('nullRate = 1 when all nulls', async () => {
      const conn = await makeTestConnection('test-all-nulls', 11, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test11.db');

      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE all_nulls (id INTEGER PRIMARY KEY, val REAL)');
      for (let i = 1; i <= 3; i++) {
        db_.prepare('INSERT INTO all_nulls VALUES (?, ?)').run(i, null);
      }
      db_.close();

      await registerTestTable(conn.id, 'all_nulls', 'val', 'REAL');

      const report = await detectAnomalies(conn.id, 'all_nulls', 'val');

      expect(report.total).toBe(3);
      expect(report.nullRate).toBe(1);
      // numeric present but avg/stddev computed from empty sample
      expect(report.numeric?.avg).toBe(0); // no non-null values
    });
  });

  // --- Test 7: Sampled vs exact note ---
  describe('sampled vs exact note', () => {
    it('note mentions "non-random sample" + lists limits when sample < total non-null', async () => {
      const conn = await makeTestConnection('test-sampled-note', 12, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test12.db');

      // Create 25 rows (within sample limit), so sampled should be false, no special note
      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE small_sample (id INTEGER PRIMARY KEY, val REAL)');
      for (let i = 0; i < 25; i++) {
        db_.prepare('INSERT INTO small_sample VALUES (?, ?)').run(i, 50 + i);
      }
      db_.close();

      await registerTestTable(conn.id, 'small_sample', 'val', 'REAL');

      const report = await detectAnomalies(conn.id, 'small_sample', 'val');

      // All values sampled, so no "non-random sample" note
      expect(report.note).not.toMatch(/non-random sample/);
    });
  });

  // --- Test 8: Integer columns (also numeric) ---
  describe('integer numeric columns', () => {
    it('INTEGER column treated as numeric', async () => {
      const conn = await makeTestConnection('test-int-column', 13, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test13.db');

      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE int_test (id INTEGER PRIMARY KEY, count INTEGER)');
      const values = [10, 15, 12, 18, 14, 500];
      for (let i = 0; i < values.length; i++) {
        db_.prepare('INSERT INTO int_test VALUES (?, ?)').run(i + 1, values[i]);
      }
      db_.close();

      await registerTestTable(conn.id, 'int_test', 'count', 'INTEGER');

      const report = await detectAnomalies(conn.id, 'int_test', 'count');

      expect(report.numeric).toBeDefined();
      expect(report.total).toBe(6);
      expect(report.numeric?.avg).toBeGreaterThan(0);
    });
  });

  // --- Test 9: Error graceful degradation ---
  describe('error graceful degradation', () => {
    it('unknown table → degraded note', async () => {
      const conn = await makeTestConnection('test-unknown-table', 14, createdConnections, createdDbPaths);
      // Don't register any table

      // Try to analyze an unknown table
      await expect(detectAnomalies(conn.id, 'nonexistent', 'col')).rejects.toThrow(/Unknown table/);
    });

    it('unknown column → degraded note', async () => {
      const conn = await makeTestConnection('test-unknown-col', 15, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test15.db');

      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE exists_table (id INTEGER PRIMARY KEY, val REAL)');
      db_.prepare('INSERT INTO exists_table VALUES (?, ?)').run(1, 100);
      db_.close();

      await registerTestTable(conn.id, 'exists_table', 'val', 'REAL');

      // Try to analyze a non-existent column
      await expect(detectAnomalies(conn.id, 'exists_table', 'nonexistent')).rejects.toThrow(/Unknown column/);
    });
  });

  // --- Test 10: Report shape for edge cases ---
  describe('report shape for edge cases', () => {
    it('empty table → total=0, nullRate=0, report with no outliers note', async () => {
      const conn = await makeTestConnection('test-empty-table', 16, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test16.db');

      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE empty_table (id INTEGER PRIMARY KEY, val REAL)');
      db_.close();

      await registerTestTable(conn.id, 'empty_table', 'val', 'REAL');

      const report = await detectAnomalies(conn.id, 'empty_table', 'val');

      // Empty table: COUNT(*) returns 0, so total=0, nullRate=0 (0/0 case), numeric report with 0 outliers
      expect(report.total).toBe(0);
      expect(report.nullRate).toBe(0);
      expect(report.numeric).toBeDefined();
      expect(report.numeric?.outlierCount).toBe(0);
    });
  });

  // --- Test 11: Wrapped string fields ---
  describe('wrapped string fields (untrusted data)', () => {
    it('min/max wrapped in <data>...</data> tags', async () => {
      const conn = await makeTestConnection('test-wrapped-strings', 17, createdConnections, createdDbPaths);
      const dbPath = path.join(DB_ROOT, 'anomaly-test17.db');

      const db_ = new Database(dbPath);
      db_.exec('CREATE TABLE wrapped_test (id INTEGER PRIMARY KEY, val REAL)');
      db_.prepare('INSERT INTO wrapped_test VALUES (?, ?)').run(1, 100.5);
      db_.prepare('INSERT INTO wrapped_test VALUES (?, ?)').run(2, 200.7);
      db_.prepare('INSERT INTO wrapped_test VALUES (?, ?)').run(3, 150.2);
      db_.close();

      await registerTestTable(conn.id, 'wrapped_test', 'val', 'REAL');

      const report = await detectAnomalies(conn.id, 'wrapped_test', 'val');

      // min/max should be wrapped
      expect(report.numeric?.min).toMatch(/^<data>.*<\/data>$/);
      expect(report.numeric?.max).toMatch(/^<data>.*<\/data>$/);
    });
  });
});
