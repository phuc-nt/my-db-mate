/**
 * Connection-config helpers shared by the connections form + API. Turns a friendly
 * engine choice into the stored (kind, dialect, config, port) and parses a
 * connection string (postgres://… / mysql://…) into the same shape — the
 * paste-a-URL flow every DB client (DBeaver, TablePlus) offers.
 */
export type Engine = 'sqlite' | 'postgres' | 'mysql';

export const DEFAULT_PORT: Record<Exclude<Engine, 'sqlite'>, number> = {
  postgres: 5432,
  mysql: 3306,
};

/** The stored kind for an engine (SQLite is a file; PG/MySQL share the TCP driver). */
export function kindForEngine(engine: Engine): 'sqlite-file' | 'tcp-driver' {
  return engine === 'sqlite' ? 'sqlite-file' : 'tcp-driver';
}

export interface ParsedConnection {
  engine: Exclude<Engine, 'sqlite'>;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: 'require' | 'disable';
}

/**
 * Parse a Postgres/MySQL connection URL. Accepts the common schemes and the
 * `sslmode=require`/`ssl=true` query hint (managed clouds set this). Throws on an
 * unrecognized scheme so the caller can show an error.
 */
export function parseConnectionString(raw: string): ParsedConnection {
  const url = new URL(raw.trim());
  const scheme = url.protocol.replace(':', '').toLowerCase();
  const engine: Exclude<Engine, 'sqlite'> =
    scheme.startsWith('postgres') ? 'postgres' :
    scheme === 'mysql' || scheme === 'mysql2' ? 'mysql' :
    (() => { throw new Error(`Unsupported scheme: ${scheme} (use postgres:// or mysql://)`); })();

  const sslmode = (url.searchParams.get('sslmode') ?? url.searchParams.get('ssl') ?? '').toLowerCase();
  const ssl: 'require' | 'disable' =
    sslmode === 'require' || sslmode === 'true' || sslmode === 'verify-full' || sslmode === 'verify-ca' || sslmode === 'prefer'
      ? 'require' : 'disable';

  return {
    engine,
    host: url.hostname,
    port: url.port ? Number(url.port) : DEFAULT_PORT[engine],
    database: url.pathname.replace(/^\//, ''),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl,
  };
}
