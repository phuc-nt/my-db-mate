/** Governed-metric adherence lint (server-side only — reuses node-sql-parser via
 *  sql-lineage, which is heavy; never import from client components).
 *
 *  A governed metric encodes a business definition in its WHERE filters (e.g.
 *  "only shipped/delivered orders" → `ord_sts_cd IN ('S','D')`). When a chat
 *  question closely matches a metric, the agent must keep those filters or its
 *  number diverges from the dashboard. This compares the columns a metric filters
 *  on against the columns the agent's SQL filters on, and reports the governed
 *  filter columns the agent dropped.
 *
 *  v1 tolerance (YAGNI): column-PRESENCE only. A gap is reported when the metric
 *  filters column X but the agent SQL has no WHERE reference to X at all — this
 *  catches the real failure (the model dropped the status filter entirely) without
 *  over-rejecting equivalent predicate forms (`IN ('S','D')` vs `= 'S' OR = 'D'`).
 *  Parse failure on EITHER side → no gap (fail-open: never block a query we can't
 *  analyze).
 *
 *  Known v1 limitations (documented so they aren't later "discovered" as bugs; all
 *  verified against the real metric corpus, which currently expresses every governed
 *  filter in a top-level WHERE, so none of these are live today):
 *  - **Bare column name, table-insensitive:** `o.status` and `c.status` both reduce to
 *    `status`. A metric filtering `orders.status` is considered satisfied by an agent
 *    SQL filtering a same-named column on a JOINed table. Acceptable for v1 (the real
 *    failure is dropping the filter entirely, which this catches); a table-qualified
 *    comparison is the future upgrade.
 *  - **Top-level WHERE only:** filters expressed in a CTE, JOIN..ON, HAVING, or a
 *    subquery are not extracted (reuses `extractLineage`, which walks `sel.where`).
 *    A metric whose governed filter lives outside its top-level WHERE is not enforced
 *    (fail-open). None of the current metrics do this.
 *  - **Column-presence, not predicate-equivalence:** `IN ('S','D')` vs `= 'S' OR = 'D'`
 *    on the same column = satisfied; a WRONG value on the right column (e.g. `= 'X'`)
 *    is NOT caught. v1 targets the dropped-filter failure, not value drift. */
import { extractLineage } from './sql-lineage';

export interface FilterGap {
  column: string;
}

/** Columns the metric SQL filters on in its WHERE clause. [] if the metric has no
 *  WHERE, or its SQL can't be parsed (fail-open — no governed predicates to enforce). */
export function extractGovernedFilterColumns(metricSql: string, dialect: string): string[] {
  return extractLineage(metricSql, dialect)?.whereColumns ?? [];
}

/** True if the agent SQL's WHERE references `column`. On parse failure returns true
 *  (fail-open — assume the filter is present rather than force a correction we can't
 *  justify). */
export function sqlFiltersColumn(agentSql: string, dialect: string, column: string): boolean {
  const lineage = extractLineage(agentSql, dialect);
  if (!lineage) return true; // unparseable agent SQL → don't accuse it of dropping a filter
  return lineage.whereColumns.includes(column);
}

/** Governed filter columns from `metricSql` that `agentSql` does NOT filter on.
 *  Empty when the agent kept all governed filters, the metric has none, or either
 *  side is unparseable (all fail-open). */
export function missingGovernedFilters(agentSql: string, metricSql: string, dialect: string): FilterGap[] {
  const governed = extractGovernedFilterColumns(metricSql, dialect);
  if (governed.length === 0) return [];
  const agentLineage = extractLineage(agentSql, dialect);
  if (!agentLineage) return []; // fail-open: can't parse agent SQL → don't force a correction
  const agentFiltered = new Set(agentLineage.whereColumns);
  return governed.filter((col) => !agentFiltered.has(col)).map((column) => ({ column }));
}
