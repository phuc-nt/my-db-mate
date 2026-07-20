/**
 * Phase 1+2 tests: semantic metric retrieval, embedding lifecycle, and context rendering.
 *
 * Tests behavioral requirements:
 * 1. Metric retrieval — relevant metric returned, per-connection (distance floor)
 * 2. Distance floor excludes unrelated metrics (METRIC_DISTANCE_FLOOR = 0.35)
 * 3. Null-embedding metric doesn't crash + isn't returned
 * 4. embed-on-save: createMetric produces non-null embedding, updateMetric re-embeds on name/description change
 * 5. backfillMetricEmbeddings: null→embedding + idempotent
 * 6. renderContextForPrompt: metrics block rendered with proper framing when present
 * 7. Verified-query floor regression: distance floor doesn't exclude closely-matching queries
 *
 * Setup: SQLite test DB (no external dependencies), real embeddings via embed().
 * Cleanup: afterEach deletes all inserted rows (connections cascade-delete metrics).
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { db } from '../db/client';
import { connections } from '../db/schema';
import { metrics } from '../db/metric-schema';
import {
  createMetric,
  updateMetric,
  backfillMetricEmbeddings,
  type MetricInput,
} from './metric-service';
import {
  getRelevantContext,
  renderContextForPrompt,
  addVerifiedQuery,
} from './context-service';
import { embed } from './embedding-service';

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

/** Create a metric with provided input. Returns the created metric or error. */
async function createTestMetric(connectionId: string, input: MetricInput) {
  const result = await createMetric(connectionId, input);
  if ('error' in result) {
    throw new Error(`createMetric failed: ${result.error}`);
  }
  return result.metric;
}

/** Read the raw `embedding` vector straight from the DB — the service return strips it
 *  (it's an internal field, never client-facing), so embedding assertions read the row. */
async function readEmbedding(metricId: string): Promise<number[] | null> {
  const [row] = await db.select({ embedding: metrics.embedding }).from(metrics).where(eq(metrics.id, metricId)).limit(1);
  return row?.embedding ?? null;
}

/** Safe SQL that returns (time_bucket, numeric_value) shape without needing real tables.
 *  Uses pure SQL generation, guaranteed to pass validation. */
function safeSampleMetricSql(): string {
  return `SELECT
    CAST('2026-01-01' AS TIMESTAMP) as time_bucket,
    100.5 as numeric_value
  UNION ALL
  SELECT CAST('2026-02-01' AS TIMESTAMP), 105.2
  UNION ALL
  SELECT CAST('2026-03-01' AS TIMESTAMP), 110.8`;
}

/** Safe SQL supporting dimensions (has GROUP BY clause for dimension rewriting).
 *  Returns (time_bucket, numeric_value, dimension) shape. */
function safeSampleMetricSqlWithDimensions(): string {
  return `SELECT
    CAST('2026-01-01' AS TIMESTAMP) as time_bucket,
    100.5 as numeric_value,
    'APAC' as region,
    'Product A' as product
  UNION ALL
  SELECT CAST('2026-02-01' AS TIMESTAMP), 105.2, 'EMEA', 'Product B'
  UNION ALL
  SELECT CAST('2026-03-01' AS TIMESTAMP), 110.8, 'AMERICAS', 'Product C'`;
}

/** Helper: create a test SQLite connection (with empty DB + tracking). */
async function makeTestConnection(name: string, testId: number, createdConnections: string[], createdDbPaths: string[]) {
  const dbPath = path.join(DB_ROOT, `test${testId}.db`);
  createdDbPaths.push(dbPath);
  new Database(dbPath).close();
  const conn = await createTestConnection(name, dbPath);
  createdConnections.push(conn.id);
  return conn;
}

/** Clean up all test data: connections (which cascade-delete their metrics). */
async function cleanupConnections(connIds: string[]) {
  for (const id of connIds) {
    await db.delete(connections).where(eq(connections.id, id));
  }
}

// ===== TESTS =====

const DB_ROOT = path.join(process.cwd(), '.cache', 'semantic-metrics-test');

describe('semantic metrics layer (Phase 1+2)', () => {
  const createdConnections: string[] = [];
  const createdDbPaths: string[] = [];

  beforeAll(async () => {
    await rm(DB_ROOT, { recursive: true, force: true });
    await mkdir(DB_ROOT, { recursive: true });
    // Warm up the embedding pipeline BEFORE any retrieval assertion. On a cold cache
    // (CI) the first embed loads the model — folding that into the first test made it
    // both slow (~5s) and flaky. Warming here isolates model load from the assertions
    // so a metric created and a question asked are embedded by the same warm pipeline.
    await embed('warmup');
  }, 60_000);

  afterEach(async () => {
    await cleanupConnections(createdConnections);
    createdConnections.length = 0;
    // Clean up SQLite files
    for (const path_ of createdDbPaths) {
      await rm(path_, { force: true });
    }
    createdDbPaths.length = 0;
  });

  // --- Test 1: Metric retrieval — relevant metric returned, per-connection ---
  describe('metric retrieval', () => {
    it('retrieves a semantically-matching metric when querying its connection', async () => {
      const connA = await makeTestConnection('test-conn-a', 1, createdConnections, createdDbPaths);

      // Create a metric with distinctive name/description
      const metric = await createTestMetric(connA.id, {
        name: 'Monthly Revenue',
        description: 'total sales revenue per month',
        sql: safeSampleMetricSql(),
        timeGrain: 'month',
      });

      // Query context with a related question
      const ctx = await getRelevantContext('what is our revenue this month', connA.id);

      // Assert the metric appears in the retrieved metrics
      expect(ctx.metrics.length).toBeGreaterThan(0);
      expect(ctx.metrics.some((m) => m.name === 'Monthly Revenue')).toBe(true);
      const found = ctx.metrics.find((m) => m.name === 'Monthly Revenue');
      expect(found?.description).toBe('total sales revenue per month');
      expect(found?.sql).toContain('UNION ALL');
    });

    it('connection A does NOT return connection B\'s metrics', async () => {
      const connA = await makeTestConnection('test-conn-a-iso1', 2, createdConnections, createdDbPaths);
      const connB = await makeTestConnection('test-conn-b-iso1', 3, createdConnections, createdDbPaths);

      // Create metric in connection A
      const metricA = await createTestMetric(connA.id, {
        name: 'Monthly Sales Revenue',
        description: 'revenue in connection A only',
        sql: safeSampleMetricSql(),
      });

      // Create metric in connection B
      const metricB = await createTestMetric(connB.id, {
        name: 'Active User Count',
        description: 'user count in connection B only',
        sql: safeSampleMetricSql(),
      });

      // Query connection A — should see A's metric, not B's
      const ctxA = await getRelevantContext('monthly sales revenue', connA.id);
      const ctxB = await getRelevantContext('active user count', connB.id);

      // A's context should include its own metric
      expect(ctxA.metrics.some((m) => m.name === 'Monthly Sales Revenue')).toBe(true);
      // A's context should NOT include B's metric
      expect(ctxA.metrics.some((m) => m.name === 'Active User Count')).toBe(false);

      // B's context should include its own metric
      expect(ctxB.metrics.some((m) => m.name === 'Active User Count')).toBe(true);
      // B's context should NOT include A's metric
      expect(ctxB.metrics.some((m) => m.name === 'Monthly Sales Revenue')).toBe(false);
    });
  });

  // --- Test 2: Distance floor excludes unrelated metrics ---
  describe('distance floor (METRIC_DISTANCE_FLOOR = 0.35)', () => {
    it('excludes a semantically-unrelated metric from retrieval', async () => {
      const conn = await makeTestConnection('test-conn-distance', 4, createdConnections, createdDbPaths);

      // Create a metric with a semantically FAR name/description
      // (server infrastructure topic vs. customer/business domain)
      const metric = await createTestMetric(conn.id, {
        name: 'Server Disk Usage Bytes',
        description: 'infrastructure disk telemetry and storage consumption',
        sql: safeSampleMetricSql(),
      });

      // Query with a question in a completely different domain
      const ctx = await getRelevantContext('customer churn rate by region', conn.id);

      // The unrelated metric should NOT be returned (distance beyond floor)
      // NOTE: with real embeddings, "churn" and "disk usage" are semantically far
      expect(ctx.metrics.some((m) => m.name === 'Server Disk Usage Bytes')).toBe(false);
    });

    it('includes a closely-matching metric even with domain words present', async () => {
      const conn = await makeTestConnection('test-conn-distance-near', 5, createdConnections, createdDbPaths);

      // Create a metric that is semantically CLOSE
      const metric = await createTestMetric(conn.id, {
        name: 'Churn Rate Monthly',
        description: 'percentage of customers who canceled their subscription each month',
        sql: safeSampleMetricSql(),
      });

      // Query with a related question
      const ctx = await getRelevantContext('what is customer churn this month', conn.id);

      // The closely-matching metric SHOULD be returned
      expect(ctx.metrics.some((m) => m.name === 'Churn Rate Monthly')).toBe(true);
    });
  });

  // --- Test 3: Null-embedding metric doesn't crash + isn't returned ---
  describe('null-embedding safety', () => {
    it('does not crash when a metric has a null embedding', async () => {
      const conn = await makeTestConnection('test-conn-null-embed', 6, createdConnections, createdDbPaths);

      // Create a metric normally (with embedding)
      const metric = await createTestMetric(conn.id, {
        name: 'Normal Metric',
        description: 'has an embedding',
        sql: safeSampleMetricSql(),
      });

      // Manually set embedding to null (simulating a pre-backfill row)
      await db.update(metrics).set({ embedding: null }).where(eq(metrics.id, metric.id));

      // Query context should not crash
      const ctx = await getRelevantContext('revenue', conn.id);

      // The null-embedding metric should NOT be returned (IS NOT NULL guard)
      expect(ctx.metrics.some((m) => m.name === 'Normal Metric')).toBe(false);
    });
  });

  // --- Test 4: embed-on-save: createMetric and updateMetric re-embed correctly ---
  describe('embedding lifecycle (create + update)', () => {
    it('createMetric generates a 384-dimensional non-null embedding', async () => {
      const conn = await makeTestConnection('test-conn-create-embed', 7, createdConnections, createdDbPaths);

      const metric = await createTestMetric(conn.id, {
        name: 'Test Metric',
        description: 'a test metric',
        sql: safeSampleMetricSql(),
      });

      const emb = await readEmbedding(metric.id);
      expect(emb).not.toBeNull();
      expect(Array.isArray(emb)).toBe(true);
      expect(emb!.length).toBe(384);
      expect(emb!.every((v) => typeof v === 'number')).toBe(true);
    });

    it('updateMetric re-embeds when name changes', async () => {
      const conn = await makeTestConnection('test-conn-update-name', 8, createdConnections, createdDbPaths);

      const metric = await createTestMetric(conn.id, {
        name: 'Original Name',
        description: 'original description',
        sql: safeSampleMetricSql(),
      });

      const oldEmbedding = await readEmbedding(metric.id);

      // Update the name
      const result = await updateMetric(metric.id, { name: 'New Name' });
      expect('error' in result).toBe(false);
      const newEmbedding = await readEmbedding(metric.id);

      // Embedding should be different (name changed)
      expect(newEmbedding).not.toEqual(oldEmbedding);
      expect(newEmbedding).toHaveLength(384);
    });

    it('updateMetric re-embeds when description changes', async () => {
      const conn = await makeTestConnection('test-conn-update-desc', 9, createdConnections, createdDbPaths);

      const metric = await createTestMetric(conn.id, {
        name: 'Test Metric',
        description: 'old description',
        sql: safeSampleMetricSql(),
      });

      const oldEmbedding = await readEmbedding(metric.id);

      // Update the description
      const result = await updateMetric(metric.id, { description: 'new description text here' });
      expect('error' in result).toBe(false);
      const newEmbedding = await readEmbedding(metric.id);

      // Embedding should be different (description changed)
      expect(newEmbedding).not.toEqual(oldEmbedding);
      expect(newEmbedding).toHaveLength(384);
    });

    it('updateMetric does NOT re-embed when only target changes', async () => {
      const conn = await makeTestConnection('test-conn-update-target', 10, createdConnections, createdDbPaths);

      const metric = await createTestMetric(conn.id, {
        name: 'Test Metric',
        description: 'test description',
        sql: safeSampleMetricSql(),
        target: 1000,
      });

      const oldEmbedding = await readEmbedding(metric.id);

      // Update only the target
      const result = await updateMetric(metric.id, { target: 2000 });
      expect('error' in result).toBe(false);
      const newEmbedding = await readEmbedding(metric.id);

      // Embedding should remain unchanged (target is not part of embedding text)
      expect(newEmbedding).toEqual(oldEmbedding);
    });

    it('updateMetric does NOT re-embed when only timeGrain changes', async () => {
      const conn = await makeTestConnection('test-conn-update-grain', 11, createdConnections, createdDbPaths);

      const metric = await createTestMetric(conn.id, {
        name: 'Test Metric',
        description: 'test description',
        sql: safeSampleMetricSql(),
        timeGrain: 'month',
      });

      const oldEmbedding = await readEmbedding(metric.id);

      // Update only timeGrain
      const result = await updateMetric(metric.id, { timeGrain: 'week' });
      expect('error' in result).toBe(false);
      const newEmbedding = await readEmbedding(metric.id);

      // Embedding should remain unchanged
      expect(newEmbedding).toEqual(oldEmbedding);
    });
  });

  // --- Test 5: backfillMetricEmbeddings ---
  describe('backfillMetricEmbeddings', () => {
    it('backfills null embeddings and returns count', async () => {
      const conn = await makeTestConnection('test-conn-backfill', 12, createdConnections, createdDbPaths);

      // Create two metrics normally
      const m1 = await createTestMetric(conn.id, {
        name: 'Metric 1',
        description: 'first',
        sql: safeSampleMetricSql(),
      });

      const m2 = await createTestMetric(conn.id, {
        name: 'Metric 2',
        description: 'second',
        sql: safeSampleMetricSql(),
      });

      // Manually null out their embeddings
      await db.update(metrics).set({ embedding: null }).where(eq(metrics.id, m1.id));
      await db.update(metrics).set({ embedding: null }).where(eq(metrics.id, m2.id));

      // Backfill
      const count = await backfillMetricEmbeddings();

      expect(count).toBeGreaterThanOrEqual(2);

      // Verify embeddings are now present
      const updated1 = await readEmbedding(m1.id);
      const updated2 = await readEmbedding(m2.id);

      expect(updated1).not.toBeNull();
      expect(updated2).not.toBeNull();
      expect(updated1).toHaveLength(384);
      expect(updated2).toHaveLength(384);
    });

    it('backfillMetricEmbeddings is idempotent', async () => {
      const conn = await makeTestConnection('test-conn-backfill-idempotent', 13, createdConnections, createdDbPaths);

      // Create metric with null embedding
      const [row] = await db
        .insert(metrics)
        .values({
          connectionId: conn.id,
          name: 'Null Embed Metric',
          description: 'starts null',
          sql: safeSampleMetricSql(),
          embedding: null,
        })
        .returning();

      // First backfill
      const count1 = await backfillMetricEmbeddings();
      expect(count1).toBeGreaterThanOrEqual(1);

      const firstEmbedding = await readEmbedding(row.id);

      // Second backfill (should not touch this row)
      const count2 = await backfillMetricEmbeddings();
      expect(count2).toBe(0);

      const secondEmbedding = await readEmbedding(row.id);

      // Embedding should be identical
      expect(secondEmbedding).toEqual(firstEmbedding);
    });
  });

  // --- Test 6: renderContextForPrompt --- metrics block ---
  describe('renderContextForPrompt — metrics block', () => {
    // renderContextForPrompt is a pure function — test it on a constructed context so
    // it's independent of the retrieval distance floor (which is tuned in Phase 3).
    const emptyCtx = { tableAnnotations: [], columnAnnotations: [], glossaryHits: [], manualRelationships: [], verifiedExamples: [], metrics: [] };

    it('includes a "Governed metrics" block when metrics are present', () => {
      const rendered = renderContextForPrompt({
        ...emptyCtx,
        metrics: [{ id: 'test-metric', name: 'Monthly Revenue', description: 'total sales revenue per month', sql: 'SELECT 1 UNION ALL SELECT 2', dimensions: null, distance: 0, timeGrain: 'month', lastRun: null, lastRunAt: null }],
      });
      expect(rendered).toContain('Governed metrics');
      expect(rendered).toContain('authoritative definitions');
      expect(rendered).toContain('do NOT invent');
      expect(rendered).toContain('Monthly Revenue');
      expect(rendered).toContain('total sales revenue per month');
      expect(rendered).toContain('UNION ALL');
    });

    it('excludes the "Governed metrics" block when metrics are empty', () => {
      const rendered = renderContextForPrompt(emptyCtx);
      expect(rendered).not.toContain('Governed metrics');
    });

    it('renders metric without dimensions when dimensions is null', () => {
      const rendered = renderContextForPrompt({
        ...emptyCtx,
        metrics: [{ id: 'test-metric', name: 'Simple Count', description: 'simple count metric', sql: 'SELECT COUNT(*) FROM t', dimensions: null, distance: 0, timeGrain: 'month', lastRun: null, lastRunAt: null }],
      });
      expect(rendered).toContain('Simple Count');
      expect(rendered).not.toContain('dimensions:');
    });

    it('renders metric with empty description and with dimensions', () => {
      const rendered = renderContextForPrompt({
        ...emptyCtx,
        metrics: [{ id: 'test-metric', name: 'No Desc Metric', description: null, sql: 'SELECT 1', dimensions: ['region', 'channel'], distance: 0, timeGrain: 'month', lastRun: null, lastRunAt: null }],
      });
      expect(rendered).toContain('No Desc Metric');
      expect(rendered).toContain('SQL:');
      expect(rendered).toContain('dimensions: region, channel');
    });
  });

  // --- Test 7: Verified-query floor regression ---
  describe('verified-query distance floor regression', () => {
    it('still retrieves closely-matching verified queries', async () => {
      const conn = await makeTestConnection('test-conn-verified-floor', 18, createdConnections, createdDbPaths);

      // Add a closely-matching verified query
      const verified = await addVerifiedQuery({
        connectionId: conn.id,
        question: 'what is the revenue per month',
        sql: 'SELECT CAST(\'2026-01-01\' AS TIMESTAMP) as month, 100.5 as revenue UNION ALL SELECT CAST(\'2026-02-01\' AS TIMESTAMP), 105.2',
      });

      // Query with similar question
      const ctx = await getRelevantContext('show me monthly revenue', conn.id);

      // Should include the verified example
      expect(ctx.verifiedExamples.length).toBeGreaterThan(0);
      expect(ctx.verifiedExamples.some((v) => v.question === 'what is the revenue per month')).toBe(true);
    });

    it('excludes clearly-unrelated verified queries', async () => {
      const conn = await makeTestConnection('test-conn-verified-far', 19, createdConnections, createdDbPaths);

      // Add an unrelated verified query
      const verified = await addVerifiedQuery({
        connectionId: conn.id,
        question: 'list all server configurations and disk usage',
        sql: 'SELECT 1 as server_id, \'config\' as config_json, 1000 as bytes_used UNION ALL SELECT 2, \'config2\', 2000',
      });

      // Query with business-domain question
      const ctx = await getRelevantContext('what is customer churn this quarter', conn.id);

      // Should NOT include the unrelated verified query
      expect(ctx.verifiedExamples.some((v) => v.question.includes('server configurations'))).toBe(false);
    });
  });

  // --- Integration: Mix of metrics + verified queries (render is a pure function) ---
  describe('mixed context integration', () => {
    it('renders both metrics and verified examples when both are present', () => {
      const rendered = renderContextForPrompt({
        tableAnnotations: [], columnAnnotations: [], glossaryHits: [], manualRelationships: [],
        verifiedExamples: [{ question: 'what percentage of users churned last month', sql: 'SELECT 15.5 as churn_pct' }],
        metrics: [{ id: 'test-metric', name: 'Churn Rate', description: 'monthly churn percentage', sql: 'SELECT 1', dimensions: null, distance: 0, timeGrain: 'month', lastRun: null, lastRunAt: null }],
      });
      expect(rendered).toContain('Governed metrics');
      expect(rendered).toContain('Churn Rate');
      expect(rendered).toContain('Verified example queries');
      expect(rendered).toContain('what percentage of users churned');
    });
  });
});
