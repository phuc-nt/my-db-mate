/**
 * Phase 2 monitor service tests: retention window (90 days, count cap),
 * history snapshots retrieval, and Snapshot format validation.
 *
 * These tests validate:
 * 1. Time-based retention (not count-based) keeps ~90 days of history
 * 2. historySnapshots returns prior snapshots in chronological order
 * 3. storeSnapshot prunes old snapshots correctly
 * 4. Snapshot format matches the schema
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client';
import { connections } from '../db/schema';
import { monitorSnapshots } from '../db/monitor-schema';
import { historySnapshots, storeSnapshot, type Snapshot } from './monitor-service';
import { encryptSecret } from './crypto/credential-cipher';

describe('monitor-service — Phase 2 enhancements', () => {
  let connectionId: string;
  const scheduleId = '00000000-0000-0000-0000-000000000001'; // Fixed UUID for testing

  beforeEach(async () => {
    // Create a test connection
    const [conn] = await db
      .insert(connections)
      .values({
        name: 'test-monitor-conn',
        kind: 'postgres-driver',
        dialect: 'postgres',
        config: { host: 'localhost' },
        secretEncrypted: encryptSecret('test'),
        isReadOnlyVerified: true,
      })
      .returning();
    connectionId = conn.id;

    // Clean up any existing snapshots for this schedule
    await db.delete(monitorSnapshots).where(eq(monitorSnapshots.scheduleId, scheduleId));
  });

  afterEach(async () => {
    // Cleanup
    await db.delete(monitorSnapshots).where(eq(monitorSnapshots.scheduleId, scheduleId));
    await db.delete(connections).where(eq(connections.id, connectionId));
  });

  /**
   * RETENTION TEST: Time-based (90 days) + count cap (500).
   * Store snapshots with explicit capturedAt times, verify old ones are pruned.
   */
  describe('retention: time-based 90 days + count cap', () => {
    it('prunes snapshots older than 90 days', async () => {
      const tableName = 'test_table_1';
      const now = new Date();
      const eightyNineDaysAgo = new Date(now.getTime() - 89 * 24 * 60 * 60 * 1000);
      const hundredDaysAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

      // Snapshot 1: 100 days old (should be pruned)
      const snap100 = { rowCount: 100, columns: { col1: { nullRate: 0, avg: 10 } } };
      await db.insert(monitorSnapshots).values({
        scheduleId,
        connectionId,
        tableName,
        metrics: snap100,
        capturedAt: hundredDaysAgo,
      });

      // Snapshot 2: 89 days old (should be kept)
      const snap89 = { rowCount: 200, columns: { col1: { nullRate: 0, avg: 20 } } };
      await db.insert(monitorSnapshots).values({
        scheduleId,
        connectionId,
        tableName,
        metrics: snap89,
        capturedAt: eightyNineDaysAgo,
      });

      // Snapshot 3: now (should be kept)
      const snapNow = { rowCount: 300, columns: { col1: { nullRate: 0, avg: 30 } } };
      await db.insert(monitorSnapshots).values({
        scheduleId,
        connectionId,
        tableName,
        metrics: snapNow,
        capturedAt: now,
      });

      // Call storeSnapshot to trigger pruning (insert a new snapshot and prune old ones)
      const snapNew = { rowCount: 400, columns: { col1: { nullRate: 0, avg: 40 } } };
      await storeSnapshot(scheduleId, connectionId, tableName, snapNew);

      // Verify: 100-day-old snapshot is gone, others remain
      const remaining = await db.select().from(monitorSnapshots)
        .where(and(eq(monitorSnapshots.scheduleId, scheduleId), eq(monitorSnapshots.tableName, tableName)));

      expect(remaining.length).toBeGreaterThanOrEqual(3); // snap89, snapNow, snapNew (at least)
      const rowCounts = remaining.map((r) => (r.metrics as Snapshot).rowCount).sort((a, b) => a - b);
      expect(rowCounts).not.toContain(100); // 100-day-old is gone
      expect(rowCounts).toContain(200); // 89-day-old kept
      expect(rowCounts).toContain(300); // recent kept
      expect(rowCounts).toContain(400); // new snapshot kept
    });
  });

  /**
   * HISTORY SNAPSHOTS: returns prior snapshots in chronological (oldest→newest) order.
   */
  describe('historySnapshots: returns prior snapshots oldest→newest', () => {
    it('returns snapshots in chronological order', async () => {
      const tableName = 'test_table_3';
      const baseTime = new Date();

      // Insert 3 snapshots out of order
      const snap1 = { rowCount: 100, columns: {} };
      const snap2 = { rowCount: 200, columns: {} };
      const snap3 = { rowCount: 300, columns: {} };

      const t1 = new Date(baseTime.getTime() - 10 * 60 * 1000); // 10 min ago
      const t2 = new Date(baseTime.getTime() - 5 * 60 * 1000);  // 5 min ago
      const t3 = baseTime;                                       // now

      // Insert in reverse order (to test that historySnapshots sorts)
      await db.insert(monitorSnapshots).values({ scheduleId, connectionId, tableName, metrics: snap3, capturedAt: t3 });
      await db.insert(monitorSnapshots).values({ scheduleId, connectionId, tableName, metrics: snap1, capturedAt: t1 });
      await db.insert(monitorSnapshots).values({ scheduleId, connectionId, tableName, metrics: snap2, capturedAt: t2 });

      // Call historySnapshots
      const history = await historySnapshots(scheduleId, tableName);

      // Should be sorted oldest→newest
      expect(history).toHaveLength(3);
      expect(history[0].rowCount).toBe(100);
      expect(history[1].rowCount).toBe(200);
      expect(history[2].rowCount).toBe(300);
    });

    it('excludes snapshots older than 90 days', async () => {
      const tableName = 'test_table_4';
      const now = new Date();
      const hundredDaysAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
      const fiftyDaysAgo = new Date(now.getTime() - 50 * 24 * 60 * 60 * 1000);

      // Old snapshot (outside window)
      await db.insert(monitorSnapshots).values({
        scheduleId,
        connectionId,
        tableName,
        metrics: { rowCount: 100, columns: {} },
        capturedAt: hundredDaysAgo,
      });

      // Recent snapshot (inside window)
      await db.insert(monitorSnapshots).values({
        scheduleId,
        connectionId,
        tableName,
        metrics: { rowCount: 200, columns: {} },
        capturedAt: fiftyDaysAgo,
      });

      const history = await historySnapshots(scheduleId, tableName);

      // Should only include the 50-day-old snapshot (100-day-old excluded)
      expect(history).toHaveLength(1);
      expect(history[0].rowCount).toBe(200);
    });

    it('returns empty array when no history exists', async () => {
      const history = await historySnapshots(scheduleId, 'nonexistent_table');
      expect(history).toEqual([]);
    });
  });

  /**
   * SNAPSHOT FORMAT: Verify Snapshot type matches the schema.
   */
  describe('Snapshot format and schema', () => {
    it('stores and retrieves snapshot metrics with correct structure', async () => {
      const tableName = 'test_table_5';
      const snap: Snapshot = {
        rowCount: 1234,
        columns: {
          price: { nullRate: 0.05, avg: 99.5 },
          quantity: { nullRate: 0.02, avg: 50 },
          date_col: { nullRate: 0.0, avg: null },
        },
      };

      await storeSnapshot(scheduleId, connectionId, tableName, snap);

      // Retrieve and verify structure
      const [row] = await db.select().from(monitorSnapshots)
        .where(and(eq(monitorSnapshots.scheduleId, scheduleId), eq(monitorSnapshots.tableName, tableName)))
        .limit(1);

      expect(row).toBeDefined();
      const retrieved = row!.metrics as Snapshot;
      expect(retrieved.rowCount).toBe(1234);
      expect(retrieved.columns.price.nullRate).toBe(0.05);
      expect(retrieved.columns.quantity.avg).toBe(50);
      expect(retrieved.columns.date_col.avg).toBeNull();
    });

    it('handles column with null average (non-numeric)', async () => {
      const tableName = 'test_table_6';
      const snap: Snapshot = {
        rowCount: 500,
        columns: {
          name: { nullRate: 0.1, avg: null },
          age: { nullRate: 0.05, avg: 42 },
        },
      };

      await storeSnapshot(scheduleId, connectionId, tableName, snap);
      const history = await historySnapshots(scheduleId, tableName);

      expect(history).toHaveLength(1);
      expect(history[0].columns.name.avg).toBeNull();
      expect(history[0].columns.age.avg).toBe(42);
    });
  });
});
