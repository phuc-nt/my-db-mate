/**
 * Split a table name the model supplied into the `{dataset, table}` pair used to
 * look the table up in the synced schema.
 *
 * The schema listing presents a BigQuery table under whichever name the
 * warehouse resolves — `dataset.table`, or `project.dataset.table` when the
 * dataset is owned by another project — and the model is told to copy that name
 * verbatim. So the argument can arrive with one, two, or three parts, and only
 * the last two identify a row: `schema_tables` stores the dataset in
 * `schemaName` and the project in `catalogName`, never folded together.
 *
 * A project part is therefore dropped rather than parsed. It carries no
 * information the lookup needs, and keeping it would be worse than useless — the
 * caller resolves the project from the matched row precisely so a project the
 * model invented cannot redirect a read outside the connection's own catalog.
 *
 * Each part is sanitized to the identifier characters an unquoted BigQuery name
 * can hold. Splitting happens before sanitizing on purpose: stripping the dots
 * first would fuse dataset and table into a single meaningless token.
 */
export function splitTableArgument(table: string): { dataset: string; table: string } {
  const parts = table.split('.');
  const sanitize = (part: string) => part.replace(/[^A-Za-z0-9_]/g, '');
  return {
    // parts.at(-2) is absent for a bare name, which is the unqualified case.
    dataset: sanitize(parts.at(-2) ?? ''),
    table: sanitize(parts.at(-1) ?? ''),
  };
}
