/**
 * Connection-config helpers shared by the connections form + API. Turns a friendly
 * engine choice into the stored (kind, dialect, config, port) and parses a
 * connection string (postgres://… / mysql://…) into the same shape — the
 * paste-a-URL flow every DB client (DBeaver, TablePlus) offers.
 */
export type Engine = 'sqlite' | 'postgres' | 'mysql' | 'mssql';

/** TLS posture for a TCP connection.
 *  - 'disable'      — plaintext (local/LAN).
 *  - 'require'      — encrypt, do NOT verify the server cert (managed clouds with
 *                     a private CA connect out of the box, but the channel is not
 *                     MITM-proof).
 *  - 'verify-full'  — encrypt + verify the cert chain and hostname. Uses the
 *                     system CA store unless a CA PEM is provided on the config. */
export type SslMode = 'disable' | 'require' | 'verify-full';

export const DEFAULT_PORT: Record<Exclude<Engine, 'sqlite'>, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
};

/** The stored kind for an engine. SQLite is a file; SQL Server has its own driver;
 *  PG/MySQL share the TCP driver. */
export function kindForEngine(engine: Engine): 'sqlite-file' | 'tcp-driver' | 'mssql-driver' {
  if (engine === 'sqlite') return 'sqlite-file';
  if (engine === 'mssql') return 'mssql-driver';
  return 'tcp-driver';
}

export interface ParsedConnection {
  engine: Exclude<Engine, 'sqlite'>;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: SslMode;
  /** Postgres `options` connection param (e.g. CockroachDB `--cluster=<id>`).
   *  Carried through so a pasted URL doesn't silently drop it. */
  options?: string;
}

/**
 * Parse a Postgres/MySQL connection URL. Accepts the common schemes and the
 * `sslmode=…`/`ssl=true` query hint (managed clouds set this). `verify-full` and
 * `verify-ca` map to certificate verification; `require`/`prefer`/`true` map to
 * encrypt-only. The Postgres `options` param is preserved (CockroachDB Serverless
 * needs `--cluster=`). Throws on an unrecognized scheme so the caller can show an error.
 */
export function parseConnectionString(raw: string): ParsedConnection {
  const url = new URL(raw.trim());
  const scheme = url.protocol.replace(':', '').toLowerCase();
  const engine: Exclude<Engine, 'sqlite'> =
    scheme.startsWith('postgres') ? 'postgres' :
    scheme === 'mysql' || scheme === 'mysql2' ? 'mysql' :
    scheme === 'mssql' || scheme === 'sqlserver' ? 'mssql' :
    (() => { throw new Error(`Unsupported scheme: ${scheme} (use postgres://, mysql://, or sqlserver://)`); })();

  const sslmode = (url.searchParams.get('sslmode') ?? url.searchParams.get('ssl') ?? '').toLowerCase();
  const ssl: SslMode =
    sslmode === 'verify-full' || sslmode === 'verify-ca' ? 'verify-full' :
    sslmode === 'require' || sslmode === 'true' || sslmode === 'prefer' ? 'require' :
    'disable';

  const options = url.searchParams.get('options') ?? undefined;

  return {
    engine,
    host: url.hostname,
    port: url.port ? Number(url.port) : DEFAULT_PORT[engine],
    database: url.pathname.replace(/^\//, ''),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl,
    ...(options ? { options } : {}),
  };
}
