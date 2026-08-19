/**
 * How a schema summary is assembled, shared by both renderers.
 *
 * `getSchemaSummary` and `getPrunedSchemaSummary` differ only in WHICH tables
 * they pick — the full list versus a question-pruned subset. Everything after
 * that choice (governed views, the viewsOnly boundary, the verbatim-name note)
 * is the same decision, so it lives here once. The two renderers previously
 * carried it separately and drifted: only the pruned one honored the scope, so
 * the same connection described itself differently depending on which caller
 * the agent reached through.
 */
import { listViews } from './virtual-view-service';
import { VERBATIM_NAME_NOTE } from '../lib/table-catalog-prefix';
import type { SchemaScope } from './schema-scope-service';

/**
 * The governed views, presented to the agent as tables it should prefer.
 *
 * A curated view carries the business definition — the thing the raw schema
 * cannot express — so it is listed first and named as the preferred surface.
 * The description matters as much as the columns: it is what lets a question
 * phrased in business language find the right definition instead of the agent
 * reassembling one from fact tables and getting the filters subtly wrong.
 */
export async function describeViews(connectionId: string): Promise<string> {
  const views = await listViews(connectionId);
  const active = views.filter((v) => !v.isDisabled);
  if (active.length === 0) return '';
  const lines = active.map((v) => {
    const cols = (v.columnsCache ?? []).map((c) => (c.type && c.type !== 'unknown' ? `${c.name} ${c.type}` : c.name)).join(', ');
    return `${v.name}(${cols})${v.description ? ` — ${v.description}` : ''}`;
  });
  return `-- Governed views (prefer these; they carry the agreed business definitions):\n${lines.join('\n')}`;
}

/** Said instead of a table listing when `viewsOnly` is on but nothing is
 *  curated yet, so the agent reports an empty governed layer rather than
 *  guessing at table names it has not been shown. */
const NO_GOVERNED_VIEWS_NOTE =
  '-- This connection is restricted to governed views, and none are defined yet. No tables are available to query; tell the user a governed view must be created first.';

export interface ComposeSummaryInput {
  /** Output of `describeViews`, or `''` when nothing is active. */
  views: string;
  /** Rendered `table(col type, …)` lines for the chosen tables. */
  tableLines: string[];
  scope: SchemaScope | null | undefined;
  /** True when any rendered name carries a catalog prefix, which is what makes
   *  the verbatim note worth its tokens. */
  anyCatalogQualified: boolean;
}

/**
 * Join views and tables into the final summary.
 *
 * Under `viewsOnly` the curated layer is the entire interface, so raw tables are
 * not merely de-emphasised — they are omitted. Showing a table the executor will
 * refuse would only teach the agent to write queries that get blocked. This
 * fails closed: with `viewsOnly` on and no active view, the answer is an empty
 * governed layer, never the raw tables. (The previous `if (viewsOnly && views)`
 * tested a string, so an empty view set fell through to the raw listing —
 * defeating the restriction exactly when it mattered most.)
 */
export function composeSummary({ views, tableLines, scope, anyCatalogQualified }: ComposeSummaryInput): string {
  if (scope?.viewsOnly) return views || NO_GOVERNED_VIEWS_NOTE;
  const lines = anyCatalogQualified ? [VERBATIM_NAME_NOTE, ...tableLines] : tableLines;
  return [views, lines.join('\n')].filter(Boolean).join('\n\n');
}
