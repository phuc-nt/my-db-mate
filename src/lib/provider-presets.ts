/**
 * Provider presets — pure UI sugar for the connections form. Picking a preset
 * pre-fills engine / port / SSL mode / host placeholder and shows a note; the
 * stored config is still a plain tcp-driver connection (no preset id persisted,
 * no provider branching). Every field stays editable afterward.
 *
 * Ports/SSL/quirks reflect each provider's documented defaults as of 2026-07;
 * the compatibility matrix in docs/features.md carries verified/expected status.
 */
import type { Engine, SslMode } from './connection-config';

export interface ProviderPreset {
  id: string;
  label: string;
  engine: Exclude<Engine, 'sqlite'>;
  port: number;
  ssl: SslMode;
  hostPlaceholder?: string;
  /** Shown under the form when the preset is active. Keep short, actionable. */
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'generic',
    label: 'Generic / other',
    engine: 'postgres',
    port: 5432,
    ssl: 'disable',
  },
  {
    id: 'neon',
    label: 'Neon (Postgres)',
    engine: 'postgres',
    port: 5432,
    ssl: 'require',
    hostPlaceholder: 'ep-xxx-xxx.region.aws.neon.tech',
    note: 'Neon requires TLS. The pooled host (…-pooler…) works too. Neon needs SNI — fine on a direct connection; if you tunnel via SSH, set the real host.',
  },
  {
    id: 'supabase',
    label: 'Supabase (Postgres)',
    engine: 'postgres',
    port: 6543,
    ssl: 'require',
    hostPlaceholder: 'aws-0-region.pooler.supabase.com',
    note: 'Default here is the pooler (port 6543) — direct 5432 is IPv6-only on many projects and often unreachable. Use the Session pooler host from the dashboard. Switch to 5432 only if your network has direct IPv4/IPv6 reach.',
  },
  {
    id: 'rds-postgres',
    label: 'AWS RDS / Aurora (Postgres)',
    engine: 'postgres',
    port: 5432,
    ssl: 'require',
    hostPlaceholder: 'mydb.xxxx.region.rds.amazonaws.com',
    note: 'For strict verification switch SSL to verify-full and paste the AWS RDS CA bundle.',
  },
  {
    id: 'rds-mysql',
    label: 'AWS RDS / Aurora (MySQL)',
    engine: 'mysql',
    port: 3306,
    ssl: 'require',
    hostPlaceholder: 'mydb.xxxx.region.rds.amazonaws.com',
    note: 'For strict verification switch SSL to verify-full and paste the AWS RDS CA bundle.',
  },
  {
    id: 'planetscale',
    label: 'PlanetScale (MySQL)',
    engine: 'mysql',
    port: 3306,
    ssl: 'require',
    hostPlaceholder: 'aws.connect.psdb.cloud',
    note: 'TLS is mandatory. Use a database password from the PlanetScale console (branch-scoped).',
  },
  {
    id: 'tidb',
    label: 'TiDB Cloud (MySQL)',
    engine: 'mysql',
    port: 4000,
    ssl: 'require',
    hostPlaceholder: 'gateway01.region.prod.aws.tidbcloud.com',
    note: 'TiDB Serverless listens on 4000 and requires TLS.',
  },
  {
    id: 'timescale',
    label: 'Timescale Cloud (Postgres)',
    engine: 'postgres',
    port: 5432,
    ssl: 'require',
    hostPlaceholder: 'xxx.xxx.tsdb.cloud.timescale.com',
  },
  {
    id: 'cockroach',
    label: 'CockroachDB (Postgres)',
    engine: 'postgres',
    port: 26257,
    ssl: 'verify-full',
    hostPlaceholder: 'xxx.region.cockroachlabs.cloud',
    note: 'Serverless clusters need the cluster id: paste the full connection string (it carries options=--cluster=<id>, which is preserved), or add it to the connection string field. Uses public CAs — verify-full with the system store works.',
  },
  {
    id: 'aiven-postgres',
    label: 'Aiven (Postgres)',
    engine: 'postgres',
    port: 5432,
    ssl: 'verify-full',
    hostPlaceholder: 'pg-xxx.aivencloud.com',
    note: 'Aiven uses a private CA — switch nothing, just paste the CA certificate from the console into the CA field.',
  },
  {
    id: 'aiven-mysql',
    label: 'Aiven (MySQL)',
    engine: 'mysql',
    port: 3306,
    ssl: 'verify-full',
    hostPlaceholder: 'mysql-xxx.aivencloud.com',
    note: 'Aiven uses a private CA — paste the CA certificate from the console into the CA field.',
  },
  {
    id: 'azure-sql',
    label: 'Azure SQL / SQL Server',
    engine: 'mssql',
    port: 1433,
    ssl: 'require',
    hostPlaceholder: 'myserver.database.windows.net',
    note: 'Azure SQL requires TLS on 1433. Use a login with only db_datareader for read-only safety.',
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}
