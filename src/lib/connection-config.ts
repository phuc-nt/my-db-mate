/**
 * Connection-config helpers shared by the connections form + API. Turns a friendly
 * engine choice into the stored (kind, dialect, config, port) and parses a
 * connection string (postgres://… / mysql://…) into the same shape — the
 * paste-a-URL flow every DB client (DBeaver, TablePlus) offers.
 */
export type Engine = 'sqlite' | 'postgres' | 'mysql';

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
  ssl: SslMode;
}

/**
 * Parse a Postgres/MySQL connection URL. Accepts the common schemes and the
 * `sslmode=…`/`ssl=true` query hint (managed clouds set this). `verify-full` and
 * `verify-ca` map to certificate verification; `require`/`prefer`/`true` map to
 * encrypt-only. Throws on an unrecognized scheme so the caller can show an error.
 */
export function parseConnectionString(raw: string): ParsedConnection {
  const url = new URL(raw.trim());
  const scheme = url.protocol.replace(':', '').toLowerCase();
  const engine: Exclude<Engine, 'sqlite'> =
    scheme.startsWith('postgres') ? 'postgres' :
    scheme === 'mysql' || scheme === 'mysql2' ? 'mysql' :
    (() => { throw new Error(`Unsupported scheme: ${scheme} (use postgres:// or mysql://)`); })();

  const sslmode = (url.searchParams.get('sslmode') ?? url.searchParams.get('ssl') ?? '').toLowerCase();
  const ssl: SslMode =
    sslmode === 'verify-full' || sslmode === 'verify-ca' ? 'verify-full' :
    sslmode === 'require' || sslmode === 'true' || sslmode === 'prefer' ? 'require' :
    'disable';

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
