/** Build a ConnectionProvider from a stored connection row (kind + config + secret). */
import type { ConnectionProvider } from './provider-interface';
import { SqliteFileProvider } from './sqlite-file-provider';
import { DuckDbFileProvider } from './duckdb-file-provider';
import { TcpDriverProvider } from './tcp-driver-provider';
import { MssqlDriverProvider } from './mssql-driver-provider';
import { RemoteHttpProvider } from './remote-http-provider';
import { BigQueryConnectionProvider } from './bigquery-provider';
import { decryptSecret } from '../crypto/credential-cipher';

export interface ConnectionRow {
  id?: string;
  kind: string;
  dialect: string;
  config: Record<string, unknown>;
  secretEncrypted: string | null;
  sshSecretEncrypted?: string | null;
  bigqueryServiceAccountJsonEncrypted?: string | null;
  bigqueryMaxBytesPerQuery?: number | null;
}

/** Build the SSH tunnel config from the row, when the connection uses one.
 *  ssh* fields (host/port/user/authMethod) live in the plain config; the key or
 *  password is the separately-encrypted sshSecret. */
function buildSshConfig(row: ConnectionRow) {
  const c = row.config;
  if (!c.sshHost) return undefined;
  const secret = row.sshSecretEncrypted ? decryptSecret(row.sshSecretEncrypted) : '';
  const useKey = c.sshAuthMethod === 'key';
  return {
    host: String(c.sshHost),
    port: Number(c.sshPort ?? 22),
    user: String(c.sshUser ?? ''),
    ...(useKey ? { privateKey: secret } : { password: secret }),
  };
}

export function buildProvider(row: ConnectionRow): ConnectionProvider {
  switch (row.kind) {
    case 'sqlite-file':
      return new SqliteFileProvider({ path: String(row.config.path) });

    case 'duckdb-file':
      // File analytics (.duckdb / parquet / csv-dir). No secret — the data is the
      // file itself; read-only ingest-then-lock happens inside the provider's child.
      return new DuckDbFileProvider({
        mode: (String(row.config.mode) as 'duckdb' | 'parquet' | 'csv-dir'),
        path: String(row.config.path),
      });

    case 'mssql-driver': {
      const password = row.secretEncrypted ? decryptSecret(row.secretEncrypted) : '';
      return new MssqlDriverProvider({
        host: String(row.config.host),
        port: Number(row.config.port),
        database: String(row.config.database),
        user: String(row.config.user),
        password,
        ssl: row.config.ssl === 'require' || row.config.ssl === 'verify-full'
          ? (row.config.ssl as 'require' | 'verify-full') : 'disable',
        sslCa: typeof row.config.sslCa === 'string' ? row.config.sslCa : undefined,
      });
    }

    case 'tcp-driver': {
      const password = row.secretEncrypted ? decryptSecret(row.secretEncrypted) : '';
      const ssh = buildSshConfig(row);
      return new TcpDriverProvider({
        host: String(row.config.host),
        port: Number(row.config.port),
        database: String(row.config.database),
        user: String(row.config.user),
        password,
        dialect: row.dialect === 'mysql' ? 'mysql' : 'postgres',
        ssl: row.config.ssl === 'require' || row.config.ssl === 'verify-full'
          ? (row.config.ssl as 'require' | 'verify-full') : 'disable',
        sslCa: typeof row.config.sslCa === 'string' ? row.config.sslCa : undefined,
        options: typeof row.config.options === 'string' ? row.config.options : undefined,
        ...(ssh ? { ssh, connectionId: row.id ?? `test-${String(row.config.sshHost)}-${String(row.config.host)}` } : {}),
      });
    }

    case 'remote-http': {
      // P4: Cloudflare D1 over REST. The API token is the encrypted secret.
      const apiToken = row.secretEncrypted ? decryptSecret(row.secretEncrypted) : '';
      return new RemoteHttpProvider({
        accountId: String(row.config.accountId),
        databaseId: String(row.config.databaseId),
        apiToken,
      });
    }

    case 'bigquery-driver': {
      if (!row.bigqueryServiceAccountJsonEncrypted) {
        throw new Error('BigQuery connection is missing its service-account credentials');
      }
      const credentials = JSON.parse(decryptSecret(row.bigqueryServiceAccountJsonEncrypted)) as Record<string, unknown>;
      // Schema column is notNull with a default — a null/undefined here means the
      // row predates the column or was read through a code path that dropped it.
      // Fail closed rather than let executeReadOnly() run uncapped.
      if (!row.bigqueryMaxBytesPerQuery) {
        throw new Error('BigQuery connection is missing its maximumBytesBilled cap');
      }
      return new BigQueryConnectionProvider({
        projectId: String(row.config.projectId),
        credentials,
        maximumBytesBilled: row.bigqueryMaxBytesPerQuery,
      });
    }

    default:
      throw new Error(`Unknown connection kind: ${row.kind}`);
  }
}
