/**
 * One-click demo: generate a small synthetic online-shop SQLite DB, register it
 * as a connection, and seed the context layer (glossary + annotations + verified
 * queries). The schema deliberately uses opaque enum codes (`ord_sts_cd`,
 * `seg_cd`, …) — the kind an LLM cannot guess — so the demo shows what the
 * curated context layer is for, not just text-to-SQL.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/client';
import { connections } from '../db/schema';
import { eq } from 'drizzle-orm';
import { createConnection } from './connection-service';
import { syncSchema } from './schema-sync-service';
import {
  addGlossaryTerm,
  addVerifiedQuery,
  upsertColumnAnnotation,
  upsertTableAnnotation,
} from './context-service';

export const DEMO_CONNECTION_NAME = 'Demo — Online Shop';

const DEMO_DIR = path.resolve(process.cwd(), '.demo');
const DEMO_DB_PATH = path.join(DEMO_DIR, 'demo-shop.db');

// Deterministic LCG so every install generates identical data (docs can cite numbers).
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}

const FIRST = ['An', 'Bình', 'Chi', 'Dũng', 'Hà', 'Khoa', 'Lan', 'Minh', 'Ngọc', 'Phúc', 'Quân', 'Thảo', 'Tuấn', 'Vy', 'Yến'];
const LAST = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Vũ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ'];
const PRODUCT_NOUN = ['Headphones', 'Keyboard', 'Monitor', 'Desk Lamp', 'Backpack', 'Sneakers', 'T-Shirt', 'Water Bottle', 'Notebook', 'Pen Set', 'Coffee Maker', 'Blender', 'Novel', 'Cookbook', 'Puzzle', 'Board Game', 'Charger', 'Webcam', 'Mouse', 'Speaker'];
const PRODUCT_ADJ = ['Wireless', 'Ergonomic', 'Compact', 'Classic', 'Premium', 'Eco', 'Smart', 'Portable', 'Vintage', 'Pro'];

/** Generate the demo SQLite file. Idempotent: keeps an existing complete file,
 *  regenerates a partial one (e.g. an earlier run failed midway). */
export function ensureDemoDb(): string {
  if (fs.existsSync(DEMO_DB_PATH)) {
    try {
      const check = new Database(DEMO_DB_PATH, { readonly: true });
      const n = (check.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
      check.close();
      if (n > 0) return DEMO_DB_PATH;
    } catch { /* unreadable/incomplete → regenerate */ }
    fs.rmSync(DEMO_DB_PATH);
  }
  fs.mkdirSync(DEMO_DIR, { recursive: true });

  const sq = new Database(DEMO_DB_PATH);
  sq.pragma('journal_mode = WAL');
  sq.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      seg_cd TEXT NOT NULL,          -- S1|S2|S3|S4 (opaque on purpose)
      reg_ch TEXT NOT NULL,          -- W|A|S
      created_at TEXT NOT NULL
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      cat_cd TEXT NOT NULL,          -- EL|FA|HO|BK|TO
      unit_price REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      ord_sts_cd TEXT NOT NULL,      -- P|A|S|D|C|R
      pay_mtd_cd TEXT NOT NULL,      -- CC|BT|CD|EW
      order_date TEXT NOT NULL,
      total_amt REAL NOT NULL
    );
    CREATE TABLE order_items (
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      qty INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      PRIMARY KEY (order_id, product_id)
    );
  `);

  const rng = makeRng(20260710);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rng() * arr.length)];

  const CUSTOMERS = 500;
  const PRODUCTS = 200;
  const ORDERS = 5000;
  const now = Date.now();
  const DAY = 86_400_000;
  // Orders span the last ~18 months so "last month / theo tháng" questions have data.
  const dateWithinDays = (maxAgo: number) =>
    new Date(now - Math.floor(rng() * maxAgo) * DAY).toISOString().slice(0, 10);

  const insCust = sq.prepare('INSERT INTO customers VALUES (?,?,?,?,?,?)');
  for (let i = 1; i <= CUSTOMERS; i++) {
    const name = `${pick(LAST)} ${pick(FIRST)}`;
    const seg = rng() < 0.08 ? 'S1' : rng() < 0.45 ? 'S2' : rng() < 0.8 ? 'S3' : 'S4';
    insCust.run(i, name, `user${i}@example.com`, seg, pick(['W', 'W', 'A', 'A', 'S']), dateWithinDays(540));
  }

  const insProd = sq.prepare('INSERT INTO products VALUES (?,?,?,?,?)');
  for (let i = 1; i <= PRODUCTS; i++) {
    const cat = pick(['EL', 'EL', 'FA', 'HO', 'BK', 'TO']);
    insProd.run(i, `${pick(PRODUCT_ADJ)} ${pick(PRODUCT_NOUN)}`, cat, Math.round((5 + rng() * 295) * 100) / 100, rng() < 0.93 ? 1 : 0);
  }

  const insOrder = sq.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?)');
  const insItem = sq.prepare('INSERT OR IGNORE INTO order_items VALUES (?,?,?,?)');
  const prices: number[] = sq.prepare('SELECT unit_price FROM products ORDER BY id').all().map((r) => (r as { unit_price: number }).unit_price);
  const seedOrders = sq.transaction(() => {
    for (let i = 1; i <= ORDERS; i++) {
      const r = rng();
      // Status mix: most orders end delivered; a visible cancelled/returned tail.
      const sts = r < 0.05 ? 'P' : r < 0.1 ? 'A' : r < 0.25 ? 'S' : r < 0.82 ? 'D' : r < 0.93 ? 'C' : 'R';
      // Build the item list first (the order row needs the total, and FK
      // enforcement requires the order row to exist before its items).
      const nItems = 1 + Math.floor(rng() * 4);
      const items: Array<{ pid: number; qty: number }> = [];
      const seen = new Set<number>();
      let total = 0;
      for (let k = 0; k < nItems; k++) {
        const pid = 1 + Math.floor(rng() * PRODUCTS);
        if (seen.has(pid)) continue;
        seen.add(pid);
        const qty = 1 + Math.floor(rng() * 3);
        items.push({ pid, qty });
        total += qty * prices[pid - 1];
      }
      insOrder.run(i, 1 + Math.floor(rng() * CUSTOMERS), sts, pick(['CC', 'CC', 'EW', 'EW', 'BT', 'CD']), dateWithinDays(540), Math.round(total * 100) / 100);
      for (const it of items) insItem.run(i, it.pid, it.qty, prices[it.pid - 1]);
    }
  });
  seedOrders();
  sq.close();
  return DEMO_DB_PATH;
}

/** Seed the context layer that makes the opaque codes answerable. */
async function seedDemoContext(connectionId: string) {
  await upsertTableAnnotation({ connectionId, tableName: 'orders', description: 'One row per order. total_amt is the order total in USD, already including all items.' });
  await upsertColumnAnnotation({ connectionId, tableName: 'orders', columnName: 'ord_sts_cd', description: "Order status code: P=pending, A=allocated, S=shipped, D=delivered, C=cancelled, R=returned. 'Completed' means D." });
  await upsertColumnAnnotation({ connectionId, tableName: 'orders', columnName: 'pay_mtd_cd', description: 'Payment method: CC=credit card, BT=bank transfer, CD=cash on delivery, EW=e-wallet.' });
  await upsertColumnAnnotation({ connectionId, tableName: 'customers', columnName: 'seg_cd', description: 'Customer segment: S1=VIP, S2=regular, S3=occasional, S4=dormant.' });
  await upsertColumnAnnotation({ connectionId, tableName: 'customers', columnName: 'reg_ch', description: 'Registration channel: W=web, A=mobile app, S=in-store.' });
  await upsertColumnAnnotation({ connectionId, tableName: 'products', columnName: 'cat_cd', description: 'Category: EL=electronics, FA=fashion, HO=home, BK=books, TO=toys.' });

  await addGlossaryTerm({ connectionId, term: 'revenue', definition: 'Sum of total_amt over orders that were shipped or delivered (excludes pending, cancelled, returned).', sqlMapping: "SUM(total_amt) FILTER: ord_sts_cd IN ('S','D')" });
  await addGlossaryTerm({ connectionId, term: 'cancelled order', definition: 'An order with status code C.', sqlMapping: "ord_sts_cd = 'C'" });
  await addGlossaryTerm({ connectionId, term: 'VIP customer', definition: 'Customer in segment S1.', sqlMapping: "customers.seg_cd = 'S1'" });

  await addVerifiedQuery({
    connectionId,
    question: 'Monthly revenue for the last 12 months',
    sql: "SELECT strftime('%Y-%m', order_date) AS month, ROUND(SUM(total_amt), 2) AS revenue FROM orders WHERE ord_sts_cd IN ('S','D') AND order_date >= date('now','-12 months') GROUP BY month ORDER BY month",
    tablesUsed: ['orders'],
  });
  await addVerifiedQuery({
    connectionId,
    question: 'Top 10 products by revenue',
    sql: "SELECT p.name, ROUND(SUM(oi.qty * oi.unit_price), 2) AS revenue FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id WHERE o.ord_sts_cd IN ('S','D') GROUP BY p.id ORDER BY revenue DESC LIMIT 10",
    tablesUsed: ['orders', 'order_items', 'products'],
  });
}

/** Create (or return) the demo connection. Idempotent by connection name. */
export async function ensureDemoConnection(): Promise<{ id: string; created: boolean }> {
  const existing = await db.select({ id: connections.id }).from(connections).where(eq(connections.name, DEMO_CONNECTION_NAME));
  if (existing.length > 0) return { id: existing[0].id, created: false };

  const dbPath = ensureDemoDb();
  const row = await createConnection({
    name: DEMO_CONNECTION_NAME,
    kind: 'sqlite-file',
    dialect: 'sqlite',
    config: { path: dbPath },
  });
  await syncSchema(row.id);
  await seedDemoContext(row.id);
  return { id: row.id, created: true };
}
