import { describe, expect, it } from 'vitest';
import { diffSnapshots, DEFAULT_THRESHOLDS, type Snapshot } from '../lib/monitor-diff';

const snap = (rowCount: number, columns: Snapshot['columns'] = {}): Snapshot => ({ rowCount, columns });

describe('diffSnapshots', () => {
  it('healthy: small drift → no findings', () => {
    expect(diffSnapshots('t', snap(1000), snap(1100))).toEqual([]);
  });

  it('row-count collapse past pct + abs floor → finding', () => {
    const f = diffSnapshots('orders', snap(1000), snap(400));
    expect(f).toHaveLength(1);
    expect(f[0].metric).toBe('rowCount');
    expect(f[0].deltaPct).toBe(-60);
  });

  it('small table: big % but under absolute floor → silent', () => {
    // 10 → 4 rows = -60% but |Δ|=6 < 20 floor
    expect(diffSnapshots('tiny', snap(10), snap(4))).toEqual([]);
  });

  it('row growth past threshold also alerts (data flood)', () => {
    const f = diffSnapshots('t', snap(100), snap(200));
    expect(f[0]?.metric).toBe('rowCount');
  });

  it('null-rate spike alerts', () => {
    const f = diffSnapshots('t', snap(500, { amt: { nullRate: 0.01, avg: 10 } }), snap(500, { amt: { nullRate: 0.2, avg: 10 } }));
    expect(f.map((x) => x.metric)).toContain('nullRate:amt');
  });

  it('null-rate small rise → silent', () => {
    expect(diffSnapshots('t', snap(500, { amt: { nullRate: 0.01, avg: 10 } }), snap(500, { amt: { nullRate: 0.05, avg: 10 } }))).toEqual([]);
  });

  it('avg shift past 50% alerts; avg=0 baseline is guarded', () => {
    const f = diffSnapshots('t', snap(500, { amt: { nullRate: 0, avg: 100 } }), snap(500, { amt: { nullRate: 0, avg: 10 } }));
    expect(f.map((x) => x.metric)).toContain('avg:amt');
    expect(diffSnapshots('t', snap(500, { z: { nullRate: 0, avg: 0 } }), snap(500, { z: { nullRate: 0, avg: 99 } }))).toEqual([]);
  });

  it('column present only in current snapshot → ignored (no prev to compare)', () => {
    expect(diffSnapshots('t', snap(500, {}), snap(500, { neu: { nullRate: 0.9, avg: 1 } }))).toEqual([]);
  });

  it('custom thresholds respected', () => {
    const strict = { ...DEFAULT_THRESHOLDS, rowCountPct: 5 };
    expect(diffSnapshots('t', snap(1000), snap(1100), strict)).toHaveLength(1);
  });
});
