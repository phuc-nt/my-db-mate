/**
 * Phase 1 — Step 0 risk gate (RT-F9).
 *
 * Verifies the configured OpenRouter model is fit for My DB Mate's agentic loop
 * BEFORE any further investment. Two parts:
 *   (a) Tool-calling plumbing: model must chain multiple tool calls and use their
 *       results (schema_explore -> schema_details -> execute_sql style).
 *   (b) Accuracy probe: 5 gold NL->SQL tasks on a tiny known schema; we check the
 *       generated SQL is executable + returns the expected shape.
 *
 * The research accuracy figures were measured on Claude Sonnet 5, NOT qwen3.7-max,
 * so this probe is the first place we learn whether the chosen model actually works.
 *
 * Exit code 0 = pass, 1 = fail (so it can gate CI / the build).
 */
import 'dotenv/config';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import initSqlJs from 'sql.js';

const apiKey = process.env.OPENROUTER_API_KEY;
const modelName = process.env.OPENROUTER_MODEL ?? 'qwen/qwen3.7-max';
if (!apiKey) {
  console.error('OPENROUTER_API_KEY missing in .env');
  process.exit(1);
}

const openrouter = createOpenRouter({ apiKey });
const model = openrouter(modelName);

// ---------------------------------------------------------------------------
// Tiny in-memory SQLite fixture (sql.js) acting as the "target DB" for the probe.
// Mirrors the ebook-catalog shape (books, categories, M-N) so the probe reflects
// the real dogfood schema without touching any real file.
// ---------------------------------------------------------------------------
type Db = {
  exec: (sql: string) => { columns: string[]; values: unknown[][] }[];
};

async function makeFixtureDb(): Promise<Db> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL, year INTEGER, price REAL);
    CREATE TABLE book_categories (book_id INTEGER, category_id INTEGER);
    INSERT INTO categories (id,name) VALUES (1,'Fiction'),(2,'Science'),(3,'History');
    INSERT INTO books (id,title,year,price) VALUES
      (1,'Dune',1965,12.5),(2,'Cosmos',1980,9.0),(3,'Sapiens',2011,15.0),
      (4,'Foundation',1951,11.0),(5,'A Brief History of Time',1988,10.5);
    INSERT INTO book_categories (book_id,category_id) VALUES
      (1,1),(2,2),(3,3),(4,1),(4,2),(5,2);
  `);
  return db as unknown as Db;
}

function runSql(db: Db, sql: string): { columns: string[]; rows: unknown[][] } {
  const res = db.exec(sql);
  if (res.length === 0) return { columns: [], rows: [] };
  return { columns: res[0].columns, rows: res[0].values };
}

const SCHEMA_DDL = `
categories(id INT PK, name TEXT)
books(id INT PK, title TEXT, year INT, price REAL)
book_categories(book_id INT -> books.id, category_id INT -> categories.id)
`.trim();

// ---------------------------------------------------------------------------
// Part (a): tool-calling plumbing — model must chain tools and use their output.
// ---------------------------------------------------------------------------
async function testToolChaining(db: Db): Promise<boolean> {
  let sawExplore = false;
  let sawExecute = false;

  const result = await generateText({
    model,
    stopWhen: stepCountIs(6),
    system:
      'You are a SQL assistant. Use the provided tools to explore the schema and then run a query. ' +
      'Always call list_tables first, then execute a SQL query with run_sql to answer.',
    prompt:
      'How many books are in the "Science" category? Explore the schema with the tools, then run one SQL query to get the count.',
    tools: {
      list_tables: tool({
        description: 'List the tables and their columns in the database.',
        inputSchema: z.object({}),
        execute: async () => {
          sawExplore = true;
          return { schema: SCHEMA_DDL };
        },
      }),
      run_sql: tool({
        description: 'Execute a read-only SQL SELECT and return the rows.',
        inputSchema: z.object({ sql: z.string().describe('A SQLite SELECT statement') }),
        execute: async ({ sql }) => {
          sawExecute = true;
          try {
            return runSql(db, sql);
          } catch (e) {
            return { error: String(e) };
          }
        },
      }),
    },
  });

  const chained = sawExplore && sawExecute;
  const mentionsAnswer = /\b2\b|\btwo\b/i.test(result.text);
  console.log(`  [tool-chaining] list_tables=${sawExplore} run_sql=${sawExecute} answer_has_2=${mentionsAnswer}`);
  console.log(`  [tool-chaining] final: ${result.text.slice(0, 200).replace(/\n/g, ' ')}`);
  return chained && mentionsAnswer;
}

// ---------------------------------------------------------------------------
// Part (b): accuracy probe — NL -> SQL, executed, checked by expected result.
// ---------------------------------------------------------------------------
type Probe = { q: string; check: (r: { columns: string[]; rows: unknown[][] }) => boolean };

const PROBES: Probe[] = [
  { q: 'How many books are there in total?', check: (r) => Number(r.rows[0]?.[0]) === 5 },
  { q: 'What is the title of the most expensive book?', check: (r) => String(r.rows[0]?.[0] ?? r.rows[0]?.[1]) === 'Sapiens' },
  { q: 'How many books belong to the Science category?', check: (r) => Number(r.rows[0]?.[0]) === 3 },
  { q: 'List titles of books published before 1970.', check: (r) => {
      const titles = r.rows.map((row) => String(row[0])).sort();
      return titles.length === 2 && titles.includes('Dune') && titles.includes('Foundation');
    } },
  { q: 'What is the average price of all books, rounded to 1 decimal?', check: (r) => Math.abs(Number(r.rows[0]?.[0]) - 11.6) < 0.15 },
];

async function genSql(question: string): Promise<string> {
  const { text } = await generateText({
    model,
    system:
      'You translate a natural-language question into ONE SQLite SELECT query. ' +
      'Output ONLY the SQL, no markdown, no explanation.\n\nSchema:\n' + SCHEMA_DDL,
    prompt: question,
  });
  return text.replace(/```sql|```/g, '').trim().replace(/;\s*$/, '');
}

async function testAccuracy(db: Db): Promise<{ pass: number; total: number }> {
  let pass = 0;
  for (const p of PROBES) {
    let ok = false;
    let detail = '';
    try {
      const sql = await genSql(p.q);
      const res = runSql(db, sql);
      ok = p.check({ columns: res.columns, rows: res.rows });
      detail = `sql="${sql.slice(0, 80)}"`;
    } catch (e) {
      detail = `error=${String(e).slice(0, 80)}`;
    }
    if (ok) pass++;
    console.log(`  [accuracy] ${ok ? 'PASS' : 'FAIL'} — ${p.q} | ${detail}`);
  }
  return { pass, total: PROBES.length };
}

async function main() {
  console.log(`\n=== Smoke test: model="${modelName}" ===\n`);
  const db = await makeFixtureDb();

  console.log('Part (a) tool-calling plumbing:');
  const toolOk = await testToolChaining(db);

  console.log('\nPart (b) accuracy probe (NL -> SQL):');
  const { pass, total } = await testAccuracy(db);
  const accuracy = pass / total;

  console.log('\n=== RESULT ===');
  console.log(`tool-chaining: ${toolOk ? 'PASS' : 'FAIL'}`);
  console.log(`accuracy: ${pass}/${total} (${(accuracy * 100).toFixed(0)}%)`);

  // Gate: tool-chaining must work AND accuracy >= 80% (4/5) on this trivial schema.
  const gatePass = toolOk && accuracy >= 0.8;
  console.log(`\nGATE: ${gatePass ? 'PASS ✓ — proceed with this model' : 'FAIL ✗ — consider swapping OPENROUTER_MODEL'}`);
  process.exit(gatePass ? 0 : 1);
}

main().catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
