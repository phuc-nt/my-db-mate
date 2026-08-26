/**
 * Compose the schema prefix a table reference should carry, given the catalog
 * (BigQuery: project) that owns it.
 *
 * BigQuery resolves a two-part `dataset.table` against the connection's own
 * project, so a dataset shared in from elsewhere needs the project spelled out or
 * the query fails with "Dataset ... was not found". The project is stored apart
 * from the dataset — it must never enter `schemaName`, because scope matching
 * compares dataset-only names and a project-prefixed entry would match nothing —
 * and gets attached here, at the moment a reference is rendered or executed.
 *
 * The result is handed to `qualifiedTableRef` as its `schemaName` argument, which
 * already sanitizes and quotes a dotted prefix part by part.
 *
 * Returns the bare schema unchanged when there is no catalog to attach, or when
 * the dialect has no catalog level for one to mean anything against — so every
 * other engine, and every BigQuery connection synced before catalogs were
 * recorded, renders exactly as it did before.
 */
export function composeSchemaPrefix(
  dialect: string,
  catalogName: string | null | undefined,
  schemaName: string | null | undefined,
): string | null {
  if (!schemaName) return schemaName ?? null;
  if (dialect !== 'bigquery' || !catalogName) return schemaName;
  // Already carries a catalog (a caller composed it, or a scope entry was written
  // qualified) — attaching a second one would produce a four-part name.
  if (schemaName.includes('.')) return schemaName;
  return `${catalogName}.${schemaName}`;
}

/**
 * Prepended to a schema listing that contains at least one catalog-qualified
 * name, because a three-part reference is the exact thing a model likes to
 * "tidy up" back into the two-part form it has seen far more often — which
 * points the query at the connection's own project and fails.
 */
export const VERBATIM_NAME_NOTE =
  'Table names below are written exactly as this warehouse resolves them. Copy each name verbatim into your SQL — do not shorten it, requalify it, or add or remove a prefix.';
