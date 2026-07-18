/**
 * Advisor rules tests — pure logic, no live DB. A fake provider stands in for
 * the EXPLAIN (GENERIC_PLAN) verification so we can assert the verified vs
 * unverified ladder deterministically.
 */
import { describe, expect, it } from 'vitest';
import { adviseWorkload } from './advisor-rules';
import { parseIndexColumns } from './workload-stats-collector';
import type { WorkloadStats } from './workload-stats-collector';
import type { ConnectionProvider } from '../connection-providers/provider-interface';

function fakeProvider(dialect: 'postgres' | 'mysql', explainPlan?: string): ConnectionProvider {
  return {
    dialect,
    async executeReadOnly(sql: string) {
      if (/EXPLAIN/i.test(sql) && explainPlan != null) {
        return { columns: ['QUERY PLAN'], rows: explainPlan.split('\n').map((l) => [l]), rowCount: 1 };
      }
      throw new Error('unexpected query in test');
    },
  } as unknown as ConnectionProvider;
}

const base = (over: Partial<WorkloadStats>): WorkloadStats => ({
  hotspots: [], indexes: [], tables: [],
  availability: { available: true, pgVersionNum: 160002 },
  ...over,
});

describe('parseIndexColumns', () => {
  it('extracts leading + subsequent columns, ignoring ASC/DESC and quotes', () => {
    expect(parseIndexColumns('CREATE INDEX i ON t USING btree (customer_id, "status" DESC)')).toEqual(['customer_id', 'status']);
  });
  it('keeps an expression index as one entry', () => {
    expect(parseIndexColumns('CREATE INDEX i ON t (lower(email))')).toEqual(['lower(email)']);
  });
  it('returns [] when no paren group', () => {
    expect(parseIndexColumns('CREATE INDEX i ON t')).toEqual([]);
  });
});

describe('adviseWorkload — missing index', () => {
  it('suggests an index for an unindexed equality filter, verified when the plan Seq-Scans', async () => {
    const stats = base({
      hotspots: [{ sql: "SELECT * FROM orders WHERE status = $1", calls: 500, totalMs: 8000, meanMs: 16, rows: 500 }],
      indexes: [],
    });
    const provider = fakeProvider('postgres', 'Seq Scan on orders  (cost=0.00..1.00 rows=1)');
    const { findings } = await adviseWorkload(stats, provider);
    const mi = findings.find((f) => f.kind === 'missing-index');
    expect(mi).toBeDefined();
    expect(mi!.ddl).toContain('CREATE INDEX ON "orders" ("status")');
    expect(mi!.verification).toBe('verified-by-explain');
    expect(mi!.evidence).toMatch(/Seq Scan on orders/);
  });

  it('does NOT suggest when the column is already an index leading column', async () => {
    const stats = base({
      hotspots: [{ sql: "SELECT * FROM orders WHERE status = $1", calls: 500, totalMs: 8000, meanMs: 16, rows: 500 }],
      indexes: [{ schema: 'public', table: 'orders', indexName: 'ix_status', columns: ['status'], scans: 10, isUnique: false, isPrimary: false, definition: 'CREATE INDEX ix_status ON orders (status)' }],
    });
    const { findings } = await adviseWorkload(stats, fakeProvider('postgres', 'Index Scan'));
    expect(findings.find((f) => f.kind === 'missing-index')).toBeUndefined();
  });

  it('stays unverified when the plan shows no Seq Scan on that table', async () => {
    const stats = base({ hotspots: [{ sql: "SELECT * FROM orders WHERE status = $1", calls: 1, totalMs: 5, meanMs: 5, rows: 1 }] });
    const { findings } = await adviseWorkload(stats, fakeProvider('postgres', 'Index Scan using pk on orders'));
    const mi = findings.find((f) => f.kind === 'missing-index');
    expect(mi!.verification).toBe('unverified');
  });

  it('does NOT verify off a prefix-sharing table in the plan (no mis-attributed evidence)', async () => {
    const stats = base({ hotspots: [{ sql: "SELECT count(*) FROM orders WHERE status = $1", calls: 40, totalMs: 500, meanMs: 12, rows: 1 }] });
    // Plan Seq-Scans orders_archive (a DIFFERENT table via subquery), NOT orders.
    const { findings } = await adviseWorkload(stats, fakeProvider('postgres', 'Seq Scan on orders_archive  (cost=0.00..1.00)'));
    expect(findings.find((f) => f.kind === 'missing-index')!.verification).toBe('unverified');
  });

  it('verifies against a schema-qualified plan line (public.orders)', async () => {
    const stats = base({ hotspots: [{ sql: "SELECT count(*) FROM orders WHERE status = $1", calls: 40, totalMs: 500, meanMs: 12, rows: 1 }] });
    const { findings } = await adviseWorkload(stats, fakeProvider('postgres', 'Seq Scan on public.orders  (cost=0.00..1.00)'));
    expect(findings.find((f) => f.kind === 'missing-index')!.verification).toBe('verified-by-explain');
  });

  it('multi-table candidate is never verified (Seq-Scan attribution unreliable)', async () => {
    const stats = base({
      hotspots: [{ sql: "SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id WHERE c.region = $1", calls: 100, totalMs: 900, meanMs: 9, rows: 50 }],
    });
    const { findings } = await adviseWorkload(stats, fakeProvider('postgres', 'Seq Scan on customers'));
    for (const f of findings.filter((x) => x.kind === 'missing-index')) {
      expect(f.verification).toBe('unverified');
    }
  });

  it('PG<16 never verifies (GENERIC_PLAN unavailable)', async () => {
    const stats = base({
      availability: { available: true, pgVersionNum: 150000 },
      hotspots: [{ sql: "SELECT * FROM orders WHERE status = $1", calls: 500, totalMs: 8000, meanMs: 16, rows: 500 }],
    });
    const { findings } = await adviseWorkload(stats, fakeProvider('postgres'));
    expect(findings.find((f) => f.kind === 'missing-index')!.verification).toBe('unverified');
  });

  it('MySQL suggestions are always unverified with the placeholder caveat', async () => {
    const stats = base({
      availability: { available: true },
      hotspots: [{ sql: "SELECT * FROM orders WHERE status = ?", calls: 500, totalMs: 8000, meanMs: 16, rows: 500 }],
    });
    const { findings } = await adviseWorkload(stats, fakeProvider('mysql'));
    const mi = findings.find((f) => f.kind === 'missing-index');
    expect(mi!.verification).toBe('unverified');
    expect(mi!.ddl).toContain('`orders`');
  });

  it('counts unparseable hotspots instead of dropping them silently', async () => {
    const stats = base({ hotspots: [{ sql: 'NOT VALID SQL @@@', calls: 1, totalMs: 1, meanMs: 1, rows: 0 }] });
    const { unparsedCount } = await adviseWorkload(stats, fakeProvider('postgres'));
    expect(unparsedCount).toBe(1);
  });
});

describe('adviseWorkload — unused index', () => {
  it('flags a zero-scan non-PK/unique index with a dialect-correct DROP', async () => {
    const stats = base({
      indexes: [{ schema: 'public', table: 'orders', indexName: 'ix_dead', columns: ['note'], scans: 0, isUnique: false, isPrimary: false, definition: '' }],
    });
    const { findings } = await adviseWorkload(stats, fakeProvider('postgres'));
    const ui = findings.find((f) => f.kind === 'unused-index');
    expect(ui!.ddl).toBe('DROP INDEX "ix_dead";');
    expect(ui!.verification).toBe('unverified');
  });

  it('never flags a PK or unique index', async () => {
    const stats = base({
      indexes: [
        { schema: 'public', table: 'orders', indexName: 'orders_pkey', columns: ['id'], scans: 0, isUnique: true, isPrimary: true, definition: '' },
        { schema: 'public', table: 'orders', indexName: 'uq_email', columns: ['email'], scans: 0, isUnique: true, isPrimary: false, definition: '' },
      ],
    });
    const { findings } = await adviseWorkload(stats, fakeProvider('postgres'));
    expect(findings.find((f) => f.kind === 'unused-index')).toBeUndefined();
  });
});
