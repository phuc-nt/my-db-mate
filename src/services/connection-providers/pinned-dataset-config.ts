/**
 * Validation for the pinned cross-project datasets a BigQuery connection may
 * declare (`config.extraDatasets`).
 *
 * These strings become part of a table reference the query builders emit into
 * real SQL, so they are checked at the write boundary rather than trusted and
 * sanitized later: an entry that survives here is guaranteed to be exactly
 * `project.dataset` with BigQuery's own legal charset (project ids allow
 * hyphens, dataset ids do not), which is what lets the render layer split on the
 * dot and quote each half without guessing.
 *
 * A three-part `project.dataset.table` is rejected on purpose — a pinned entry
 * names a dataset to introspect, not a single table, and accepting one would
 * silently sync nothing.
 */

/** project ids: letters, digits, hyphens. dataset ids: letters, digits, underscores. */
const PINNED_DATASET_RE = /^[A-Za-z0-9-]+\.[A-Za-z0-9_]+$/;

export class InvalidPinnedDatasetError extends Error {
  constructor(entry: string) {
    super(
      `Invalid external dataset "${entry}" — expected project.dataset ` +
        '(e.g. bigquery-public-data.thelook_ecommerce)',
    );
    this.name = 'InvalidPinnedDatasetError';
  }
}

/**
 * Normalize whatever arrived on `config.extraDatasets` into a clean string list.
 * Trims, drops blanks, de-duplicates, and throws on anything malformed. Returns
 * undefined when nothing was pinned, so the key stays absent from config rather
 * than being stored as an empty array.
 */
export function normalizePinnedDatasets(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new InvalidPinnedDatasetError(String(raw));

  const out: string[] = [];
  for (const item of raw) {
    const entry = String(item).trim();
    if (!entry) continue;
    if (!PINNED_DATASET_RE.test(entry)) throw new InvalidPinnedDatasetError(entry);
    if (!out.includes(entry)) out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Apply the normalizer to a connection config in place of the raw value, for the
 * create/update boundary. Non-BigQuery connections never carry the key, so it is
 * simply dropped there instead of validated — an OLTP config has no catalog level
 * for it to mean anything against.
 */
export function withValidatedPinnedDatasets(
  kind: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!('extraDatasets' in config)) return config;
  const rest = { ...config };
  delete rest.extraDatasets;
  if (kind !== 'bigquery-driver') return rest;
  const pinned = normalizePinnedDatasets(config.extraDatasets);
  return pinned ? { ...rest, extraDatasets: pinned } : rest;
}
