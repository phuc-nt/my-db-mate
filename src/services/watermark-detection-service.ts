/**
 * Auto-detects a candidate watermark column for incremental snapshot refresh
 * (Phase 2 of the OLAP accelerator deepening). Detection is advisory only —
 * the caller must route the suggestion through an explicit UI confirm step
 * before enabling incremental refresh; this module never enables anything.
 */

// Common timestamp-ish column names, checked in priority order (first match
// among monotonic candidates wins). Case-insensitive.
const CANDIDATE_NAME_PATTERN = /^(created_at|updated_at|modified_at|inserted_at|last_modified|last_updated)$/i;

/** True if `values` is non-decreasing, ignoring nulls (a NULL just means "no
 *  signal from this row" — it doesn't invalidate the column, since a NULL
 *  `updated_at` is common for never-updated rows and shouldn't disqualify an
 *  otherwise-monotonic column). Requires at least 2 non-null values to judge. */
function isMonotonicNonDecreasing(values: unknown[]): boolean {
  const comparable = values
    .filter((v): v is string | number | Date => v !== null && v !== undefined)
    .map((v) => (v instanceof Date ? v.getTime() : v));
  if (comparable.length < 2) return false;

  for (let i = 1; i < comparable.length; i++) {
    if (comparable[i] < comparable[i - 1]) return false;
  }
  return true;
}

/**
 * Returns the first column name that both matches a common timestamp-naming
 * pattern AND has monotonically non-decreasing sample values, or null when no
 * column qualifies. `sampleRows` should be ordered as extracted (callers pass
 * rows from an `ORDER BY` extract, or accept best-effort natural order) — this
 * function does not re-sort, so an unordered sample can under-detect but will
 * never falsely confirm a non-monotonic column as safe.
 */
export function detectWatermarkColumn(columns: string[], sampleRows: unknown[][]): string | null {
  for (let i = 0; i < columns.length; i++) {
    if (!CANDIDATE_NAME_PATTERN.test(columns[i])) continue;
    const columnValues = sampleRows.map((row) => row[i]);
    if (isMonotonicNonDecreasing(columnValues)) return columns[i];
  }
  return null;
}
