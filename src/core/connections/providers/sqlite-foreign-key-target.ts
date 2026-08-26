/**
 * Resolving SQLite foreign keys that name no target column.
 *
 * SQLite accepts `REFERENCES customers` with no column list. The constraint is
 * real — it implicitly targets the parent table's PRIMARY KEY — but
 * `PRAGMA foreign_key_list` reports the `to` field as NULL (surfaced by the
 * drivers as `null` or `''`) rather than naming the column it resolved to.
 *
 * Two ways to get this wrong, both worse than resolving it:
 *   - Store the empty value. `schema_foreign_keys.to_column` is NOT NULL, so the
 *     sync throws and the whole connection fails to introspect. Any database in
 *     the wild written with the short form becomes unusable.
 *   - Drop the row. The sync then succeeds while silently losing a join path,
 *     and the agent, seeing no relationship, writes a cross join or gives up.
 *
 * So the implicit target is resolved to the parent's primary key, which is what
 * SQLite itself does at constraint-check time.
 */

/** A foreign key row as `PRAGMA foreign_key_list` returns it. `to` is nullable
 *  precisely for the implicit-target case this module exists to handle. */
export interface PragmaForeignKeyRow {
  table: string;
  from: string;
  to: string | null;
}

/** Primary-key column names per table, in ordinal order — from
 *  `PRAGMA table_info`, filtered to `pk > 0`. */
export type PrimaryKeyLookup = (tableName: string) => readonly string[];

/**
 * The target column for one FK row, or null when it cannot be determined.
 *
 * Returns null rather than a guess when the parent table has no primary key or
 * is not in the schema (a `REFERENCES` to a missing table is legal in SQLite
 * until foreign keys are enforced). A dropped row loses a join path; a fabricated
 * one would send the agent joining on a column that does not exist, which is
 * worse — it produces confident wrong SQL instead of none.
 *
 * A COMPOSITE primary key also yields null for the implicit form. SQLite's
 * short syntax cannot express which part of a composite key it means, and
 * picking the first column would invent a relationship the schema never stated.
 */
export function resolveForeignKeyTarget(
  fk: PragmaForeignKeyRow,
  primaryKeysOf: PrimaryKeyLookup,
): string | null {
  const explicit = fk.to?.trim();
  if (explicit) return explicit;

  const pk = primaryKeysOf(fk.table);
  return pk.length === 1 ? pk[0] : null;
}
