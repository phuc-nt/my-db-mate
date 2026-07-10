/** Build a ConnectionProvider from a stored connection row (kind + config + secret). */
import type { ConnectionProvider } from './provider-interface';
import { SqliteFileProvider } from './sqlite-file-provider';
import { TcpDriverProvider } from './tcp-driver-provider';
import { RemoteHttpProvider } from './remote-http-provider';
import { decryptSecret } from '../crypto/credential-cipher';

export interface ConnectionRow {
  kind: string;
  dialect: string;
  config: Record<string, unknown>;
  secretEncrypted: string | null;
}

export function buildProvider(row: ConnectionRow): ConnectionProvider {
  switch (row.kind) {
    case 'sqlite-file':
      return new SqliteFileProvider({ path: String(row.config.path) });

    case 'tcp-driver': {
      const password = row.secretEncrypted ? decryptSecret(row.secretEncrypted) : '';
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

    default:
      throw new Error(`Unknown connection kind: ${row.kind}`);
  }
}
