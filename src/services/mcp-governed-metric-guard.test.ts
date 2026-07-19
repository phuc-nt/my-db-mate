/**
 * MCP governed-metric exposure guards: a metric id is client-supplied, so
 * run_governed_metric must only run metrics belonging to the API key's own
 * connection, and the list tool must never leak the raw metric SQL.
 */
import { describe, it, expect } from 'vitest';
import { metricBelongsToConnection, toMcpMetricSummary } from './mcp-server';

describe('metricBelongsToConnection', () => {
  it('accepts a metric on the same connection', () => {
    expect(metricBelongsToConnection({ connectionId: 'conn-a' }, 'conn-a')).toBe(true);
  });
  it('rejects a metric from another connection (guessed id)', () => {
    expect(metricBelongsToConnection({ connectionId: 'conn-b' }, 'conn-a')).toBe(false);
  });
  it('rejects a missing metric', () => {
    expect(metricBelongsToConnection(null, 'conn-a')).toBe(false);
  });
});

describe('toMcpMetricSummary (list_governed_metrics projection)', () => {
  it('never includes raw sql or embedding — binds to the real projection', () => {
    const row = { id: '1', name: 'Rev', description: 'd', timeGrain: 'month', dimensions: null, sql: 'SELECT secret FROM t', embedding: [0.1] };
    const projected = toMcpMetricSummary(row);
    expect(projected).not.toHaveProperty('sql');
    expect(projected).not.toHaveProperty('embedding');
    expect(Object.keys(projected).sort()).toEqual(['description', 'dimensions', 'id', 'name', 'timeGrain']);
  });
});
