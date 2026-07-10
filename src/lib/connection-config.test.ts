import { describe, it, expect } from 'vitest';
import { parseConnectionString } from './connection-config';

describe('parseConnectionString sslmode mapping', () => {
  it.each([
    ['postgres://u:p@h:5432/db?sslmode=verify-full', 'verify-full'],
    ['postgres://u:p@h:5432/db?sslmode=verify-ca', 'verify-full'],
    ['postgres://u:p@h:5432/db?sslmode=require', 'require'],
    ['postgres://u:p@h:5432/db?sslmode=prefer', 'require'],
    ['mysql://u:p@h:3306/db?ssl=true', 'require'],
    ['postgres://u:p@h:5432/db', 'disable'],
    ['postgres://u:p@h:5432/db?sslmode=disable', 'disable'],
  ] as const)('%s → %s', (url, ssl) => {
    expect(parseConnectionString(url).ssl).toBe(ssl);
  });

  it('parses host/port/db/user/password', () => {
    const p = parseConnectionString('postgres://alice:s3cret@db.example.com:6543/prod?sslmode=require');
    expect(p).toMatchObject({ engine: 'postgres', host: 'db.example.com', port: 6543, database: 'prod', user: 'alice', password: 's3cret', ssl: 'require' });
  });

  it('rejects unknown schemes', () => {
    expect(() => parseConnectionString('redis://h:6379/0')).toThrow(/Unsupported scheme/);
  });
});
