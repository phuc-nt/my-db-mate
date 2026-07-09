import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it external to the server bundle.
  serverExternalPackages: ['better-sqlite3', 'pg', 'mysql2', 'node-sql-parser'],
};

export default nextConfig;
