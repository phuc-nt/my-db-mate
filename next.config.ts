import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Native / native-optional modules kept external so Turbopack doesn't try to
  // bundle their platform binaries (ssh2 pulls in an optional crypto addon).
  serverExternalPackages: ['better-sqlite3', 'pg', 'mysql2', 'node-sql-parser', 'ssh2', '@duckdb/node-api'],
};

export default nextConfig;
