import { describe, it, expect } from 'vitest';
import { resolveForeignKeyTarget, type PrimaryKeyLookup } from './sqlite-foreign-key-target';

/** A schema where `customers` has a single-column PK, `orders` a composite one,
 *  and `legacy` none at all (a SQLite rowid table). */
const pks: PrimaryKeyLookup = (t) => ({
  customers: ['CustomerID'],
  orders: ['OrderDate', 'CustomerID'],
  legacy: [],
} as Record<string, string[]>)[t] ?? [];

describe('resolveForeignKeyTarget', () => {
  it('keeps an explicitly named target column', () => {
    expect(resolveForeignKeyTarget({ table: 'customers', from: 'cid', to: 'CustomerID' }, pks))
      .toBe('CustomerID');
  });

  it('resolves REFERENCES with no column to the parent primary key', () => {
    // `CustomerID INTEGER REFERENCES customers` — legal SQLite, and the case
    // that made schema sync throw on a NOT NULL to_column.
    expect(resolveForeignKeyTarget({ table: 'customers', from: 'CustomerID', to: null }, pks))
      .toBe('CustomerID');
  });

  it('treats an empty string target the same as null', () => {
    // better-sqlite3 surfaces the NULL as null, but the D1 HTTP path stringifies
    // it. Both drivers must land on the same resolution or the same database
    // would introspect differently depending on how it is reached.
    expect(resolveForeignKeyTarget({ table: 'customers', from: 'CustomerID', to: '' }, pks))
      .toBe('CustomerID');
  });

  it('declines to guess when the parent primary key is composite', () => {
    // Picking the first column would assert a relationship the schema never
    // stated, sending the agent to join on the wrong half of the key.
    expect(resolveForeignKeyTarget({ table: 'orders', from: 'oid', to: null }, pks)).toBeNull();
  });

  it('declines when the parent table has no primary key', () => {
    expect(resolveForeignKeyTarget({ table: 'legacy', from: 'lid', to: null }, pks)).toBeNull();
  });

  it('declines when the parent table is not in the schema at all', () => {
    // SQLite permits REFERENCES to a table that does not exist until foreign
    // keys are enforced.
    expect(resolveForeignKeyTarget({ table: 'ghost', from: 'gid', to: null }, pks)).toBeNull();
  });

  it('does not confuse an explicit target with the parent primary key', () => {
    // Without this, a resolver that ignored `to` and always returned the PK
    // would pass every other test here.
    expect(resolveForeignKeyTarget({ table: 'customers', from: 'cid', to: 'LegacyRef' }, pks))
      .toBe('LegacyRef');
  });
});
