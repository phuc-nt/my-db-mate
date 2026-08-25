/**
 * Build the SQLite fixture the scope/virtual-view tests read.
 *
 * Those tests need a real database to prove real things — that a rewritten view
 * returns the SAME rows as the definition inlined by hand, that a scoped
 * connection still runs in-bounds queries, that an out-of-bounds table is
 * refused at execution rather than in the prompt. The fixture used to be built
 * by hand and left in a gitignored directory, so the suites passed locally and
 * failed on CI for want of a file nobody could regenerate. Rebuilding it is now
 * one command, and CI runs it before the tests.
 *
 * Deterministic on purpose: the row values come from a seeded generator, so the
 * fixture is byte-identical everywhere and a differential assertion that passes
 * locally cannot fail on CI for want of different data.
 *
 *   npx tsx scripts/seed-scope-governance-fixture.ts
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('.testdata', 'scope-governance.sqlite');

/** Mulberry32 — a tiny seeded PRNG. `Math.random()` would make the fixture
 *  differ per machine, which is the one thing it must not do. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIONS = ['east', 'north', 'south', 'west'];
// 'P' (paid) is the status the view definition filters on, so every region must
// carry enough of it that the differential cases return non-empty results.
const STATUSES = ['A', 'I', 'P'];
const SEGMENTS = ['ent', 'self', 'smb'];
const KINDS = ['buy', 'click', 'view'];

const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];
const day = (r: () => number) => {
  const d = new Date(Date.UTC(2026, 0, 1) + Math.floor(r() * 362) * 86_400_000);
  return d.toISOString().slice(0, 10);
};

function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.rmSync(OUT, { force: true });

  const db = new Database(OUT);
  db.exec(`
    CREATE TABLE mart_orders (order_id INTEGER PRIMARY KEY, order_date TEXT, region TEXT, status TEXT, revenue REAL);
    CREATE TABLE mart_customers (customer_id INTEGER PRIMARY KEY, segment TEXT, signup_date TEXT);
    CREATE TABLE raw_pii (id INTEGER PRIMARY KEY, email TEXT, ssn TEXT, salary REAL);
    CREATE TABLE raw_events (id INTEGER PRIMARY KEY, ts TEXT, kind TEXT);
  `);

  const r = rng(20260821);
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const orders = db.prepare('INSERT INTO mart_orders VALUES (?,?,?,?,?)');
  const customers = db.prepare('INSERT INTO mart_customers VALUES (?,?,?)');
  const pii = db.prepare('INSERT INTO raw_pii VALUES (?,?,?,?)');
  const events = db.prepare('INSERT INTO raw_events VALUES (?,?,?)');

  db.transaction(() => {
    for (let i = 1; i <= 500; i++) {
      orders.run(i, day(r), pick(r, REGIONS), pick(r, STATUSES), round2(10 + r() * 884));
    }
    for (let i = 1; i <= 200; i++) customers.run(i, pick(r, SEGMENTS), day(r));
    // Deliberately sensitive-looking: these are the tables a governed scope must
    // refuse, so the values make an accidental leak obvious in a failure message.
    for (let i = 1; i <= 100; i++) {
      pii.run(i, `user${i}@example.invalid`, `000-00-${String(i).padStart(4, '0')}`, round2(40_000 + r() * 90_000));
    }
    for (let i = 1; i <= 300; i++) events.run(i, day(r), pick(r, KINDS));
  })();

  // The differential view tests filter on status 'P' and group by region; an
  // empty group would make them pass without proving anything.
  const perRegion = db.prepare(
    "SELECT region, COUNT(*) AS n FROM mart_orders WHERE status = 'P' GROUP BY region",
  ).all() as { region: string; n: number }[];
  if (perRegion.length !== REGIONS.length || perRegion.some((x) => x.n < 5)) {
    throw new Error(`fixture would not exercise the view tests: ${JSON.stringify(perRegion)}`);
  }

  db.close();
  console.log(`wrote ${OUT} (500 orders, 200 customers, 100 pii, 300 events)`);
}

main();
