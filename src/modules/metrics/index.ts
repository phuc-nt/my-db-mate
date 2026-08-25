/**
 * Governed metrics: public surface.
 *
 * Consumers: the metrics API routes, `bi` (governed widgets), `automations`
 * (digest refresh), `mcp` (exposed as a tool), and `chat-agent` — which uses
 * `missingGovernedFilters` to check that agent SQL respects a metric's governed
 * filters. `MAX_DIMENSIONS` and the embedding backfill stay internal: they are
 * implementation limits, not a contract for other modules to build on.
 *
 * Pure metric math lives in `@/core/lib/metric-math`, not here — four client
 * components import it, and a React component must not depend on a server
 * feature module to format a number.
 */
export {
  createMetric,
  listMetrics,
  getMetric,
  updateMetric,
  deleteMetric,
  runMetric,
  runMetricDrivers,
} from './metric-service';
export type { MetricInput, MetricRun } from './metric-service';
export { missingGovernedFilters } from './metric-filter-lint';
export type { FilterGap } from './metric-filter-lint';
