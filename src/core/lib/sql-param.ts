/** Date-range placeholders for dashboard widgets: `{{from}}` / `{{to}}` written
 *  WITHOUT quotes in the SQL (e.g. `BETWEEN {{from}} AND {{to}}`); substitution
 *  produces a QUOTED ISO literal `'YYYY-MM-DD'`.
 *
 *  Ordering contract (the SQL parser fail-closes on `{{`): substitution must
 *  happen BEFORE validateSql on every path — pin validates against PROBE_RANGE,
 *  execution substitutes a real or default range. Widgets store the RAW
 *  placeholder SQL. Pure module — no DB imports. */

export interface DateRange {
  from: string;
  to: string;
}

const PLACEHOLDER = /\{\{\s*(from|to)\s*\}\}/gi;
// Strict calendar-date shape; Date.parse then rejects impossible dates like 2026-02-31.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Wide range used ONLY to validate/risk-assess placeholder SQL at pin time. */
export const PROBE_RANGE: DateRange = { from: '1970-01-01', to: '2999-12-31' };

export function hasDateRangePlaceholders(sql: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(sql);
}

export function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Last 30 days ending today — the range every no-range path (refresh, refresh
 *  all, dashboard_refresh schedule) uses, so cached results and the share view
 *  always hold meaningful data. */
export function defaultDateRange(now: Date = new Date()): DateRange {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return { from, to };
}

/** Replace placeholders with quoted ISO literals. Throws on any non-ISO input —
 *  the ONLY strings that can ever enter the SQL are `'\d{4}-\d{2}-\d{2}'`. */
export function substituteDateRange(sql: string, range: DateRange): string {
  if (!isValidIsoDate(range.from)) throw new Error(`invalid from date: must be YYYY-MM-DD`);
  if (!isValidIsoDate(range.to)) throw new Error(`invalid to date: must be YYYY-MM-DD`);
  return sql.replace(PLACEHOLDER, (_, key: string) => (key.toLowerCase() === 'from' ? `'${range.from}'` : `'${range.to}'`));
}
