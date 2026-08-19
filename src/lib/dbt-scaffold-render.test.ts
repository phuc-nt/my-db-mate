/**
 * What the data team actually downloads.
 *
 * These renderers are the product's whole answer to "we have no datamart yet":
 * text a data engineer reads, reviews, and runs with their own credentials. So
 * the tests assert on the exact bytes, and especially on the two properties that
 * make the handoff trustworthy — that nothing invalid is rendered as if it were
 * runnable, and that no string the model invented can break out of the comment,
 * identifier, or YAML scalar it was placed in.
 *
 * The LLM call that produces a proposal and the BigQuery dry run that validates
 * it are covered by real-connection UAT, not here: these functions are pure, and
 * mocking either one would only assert that the mock was configured correctly.
 */
import { describe, expect, it } from 'vitest';
import {
  renderBigQueryDdl,
  renderDbtScaffold,
  safeIdentifier,
  type RenderableProposal,
} from './dbt-scaffold-render';

const stmt = (over: Partial<RenderableProposal['marts'][0]['summaryTables'][0]> = {}) => ({
  name: 'daily_revenue',
  description: 'Revenue per day',
  sql: 'SELECT 1 AS a',
  valid: true,
  ...over,
});

const proposal = (over: Partial<RenderableProposal> = {}): RenderableProposal => ({
  marts: [
    {
      name: 'sales',
      purpose: 'Track revenue',
      grain: 'One row per day',
      sourceTables: ['raw.orders'],
      assumptions: ['orders.user_id joins users.id (guessed from names)'],
      summaryTables: [stmt()],
    },
  ],
  ...over,
});

describe('safeIdentifier', () => {
  it.each([
    ['Monthly Sales', 'monthly_sales'],
    ['UPPER_CASE', 'upper_case'],
    ['  padded  ', 'padded'],
    ['weird!!chars@@here', 'weird_chars_here'],
    ['__leading_and_trailing__', 'leading_and_trailing'],
    ['tên_tiếng_việt', 't_n_ti_ng_vi_t'],
  ])('normalizes %s', (raw, expected) => {
    expect(safeIdentifier(raw)).toBe(expected);
  });

  it('prefixes a leading digit, which no SQL identifier may start with', () => {
    expect(safeIdentifier('2024_sales')).toBe('_2024_sales');
  });

  it('never returns an empty identifier', () => {
    // An empty name would render as `\`marts.\`` — syntactically broken DDL that
    // the data team would have to debug on our behalf.
    expect(safeIdentifier('!!!')).toBe('unnamed');
    expect(safeIdentifier('')).toBe('unnamed');
  });
});

describe('renderBigQueryDdl', () => {
  it('leads with the statement that nothing has been executed', () => {
    // The advisory-only posture is the product's core promise; it belongs at the
    // top of the file, not in a UI banner the downloaded text does not carry.
    const out = renderBigQueryDdl(proposal(), 'marts');
    expect(out).toContain('NOTHING HERE HAS BEEN EXECUTED');
    expect(out).toContain('never writes to a warehouse');
  });

  it('renders one CREATE OR REPLACE VIEW per valid statement, in the target dataset', () => {
    const out = renderBigQueryDdl(proposal(), 'my_marts');
    expect(out).toContain('CREATE OR REPLACE VIEW `my_marts.sales__daily_revenue` AS');
    expect(out.match(/CREATE OR REPLACE VIEW/g)).toHaveLength(1);
  });

  it('falls back to the default dataset when given a blank one', () => {
    expect(renderBigQueryDdl(proposal(), '   ')).toContain('`marts.sales__daily_revenue`');
  });

  it('omits statements that failed validation', () => {
    // Rendering an invalid statement would hand the data team DDL that fails when
    // they run it — the exact outcome this export exists to prevent.
    const p = proposal();
    p.marts[0].summaryTables = [stmt({ name: 'good' }), stmt({ name: 'bad', valid: false })];
    const out = renderBigQueryDdl(p, 'marts');
    expect(out).toContain('sales__good');
    expect(out).not.toContain('sales__bad');
  });

  it('skips a mart entirely when none of its statements are valid', () => {
    const p = proposal();
    p.marts[0].summaryTables = [stmt({ valid: false })];
    const out = renderBigQueryDdl(p, 'marts');
    expect(out).not.toContain('Mart: sales');
    expect(out).not.toContain('CREATE OR REPLACE VIEW');
  });

  it('carries the grain and the guessed joins into the file as comments', () => {
    // A guessed join is the proposal's weakest claim; it has to travel with the
    // DDL so whoever runs it knows what to check.
    const out = renderBigQueryDdl(proposal(), 'marts');
    expect(out).toContain('-- Grain:   One row per day');
    expect(out).toContain('-- Assumes: orders.user_id joins users.id (guessed from names)');
  });

  it('neutralizes a comment terminator hidden in model-authored prose', () => {
    // Every commented string here was written by an LLM from untrusted schema
    // text. A `*/` would end the comment and leave the rest of the sentence
    // sitting in the file as SQL.
    const p = proposal();
    p.marts[0].purpose = 'ends comment */ DROP TABLE users; --';
    const out = renderBigQueryDdl(p, 'marts');
    expect(out).not.toContain('*/');
    expect(out).toContain('* /');
  });

  it('flattens a multi-line description so it cannot escape its comment line', () => {
    const p = proposal();
    p.marts[0].summaryTables = [stmt({ description: 'line one\nDROP TABLE users;' })];
    const out = renderBigQueryDdl(p, 'marts');
    expect(out).toContain('-- line one DROP TABLE users;');
    // The injected statement stays inside the comment: the line before the
    // CREATE is the comment, not a bare DROP.
    const lines = out.split('\n');
    const createAt = lines.findIndex((l) => l.startsWith('CREATE OR REPLACE VIEW'));
    expect(lines[createAt - 1].startsWith('--')).toBe(true);
  });

  it('strips a trailing semicolon so the emitted statement is not doubled', () => {
    const p = proposal();
    p.marts[0].summaryTables = [stmt({ sql: 'SELECT 1 AS a;  ' })];
    expect(renderBigQueryDdl(p, 'marts')).not.toContain(';;');
  });
});

describe('renderDbtScaffold', () => {
  it('writes one model file per valid statement, under its mart directory', () => {
    const files = renderDbtScaffold(proposal());
    const paths = files.map((f) => f.path);
    expect(paths).toContain('models/sales/sales__daily_revenue.sql');
    expect(paths).toContain('models/schema.yml');
  });

  it('configures models as views, matching the DDL export', () => {
    const sql = renderDbtScaffold(proposal()).find((f) => f.path.endsWith('.sql'))!;
    expect(sql.contents).toContain("{{ config(materialized='view') }}");
    expect(sql.contents).toContain('SELECT 1 AS a');
  });

  it('documents columns from what the warehouse returned, not from parsing SQL', () => {
    // The point of sourcing columns from the dry run: the docs stay right even
    // where the SQL does something the renderer cannot read.
    const p = proposal();
    p.marts[0].summaryTables = [
      stmt({ sql: 'SELECT some_udf(x) AS revenue', columns: [{ name: 'revenue', type: 'FLOAT64' }] }),
    ];
    const yml = renderDbtScaffold(p).find((f) => f.path === 'models/schema.yml')!;
    expect(yml.contents).toContain('- name: revenue');
    expect(yml.contents).toContain('FLOAT64');
  });

  it('omits the columns block when the warehouse returned none', () => {
    const yml = renderDbtScaffold(proposal()).find((f) => f.path === 'models/schema.yml')!;
    expect(yml.contents).not.toContain('columns:');
  });

  it('still emits a valid schema.yml when nothing passed validation', () => {
    // A scaffold with no models is a real outcome (every statement rejected);
    // it must still be a parseable file rather than a truncated one.
    const p = proposal();
    p.marts[0].summaryTables = [stmt({ valid: false })];
    const files = renderDbtScaffold(p);
    expect(files.filter((f) => f.path.endsWith('.sql'))).toHaveLength(0);
    const yml = files.find((f) => f.path === 'models/schema.yml')!;
    expect(yml.contents).toContain('version: 2');
    expect(yml.contents.trimEnd().endsWith('models:')).toBe(true);
  });

  it('escapes a quote in a description so the YAML scalar cannot be broken out of', () => {
    const p = proposal();
    p.marts[0].summaryTables = [stmt({ description: 'say "hi" then\nnewline' })];
    const yml = renderDbtScaffold(p).find((f) => f.path === 'models/schema.yml')!;
    expect(yml.contents).toContain('description: "say \\"hi\\" then newline"');
  });

  it('escapes a backslash before the quote escaping, not after', () => {
    // Order matters: escaping quotes first would leave `\\"` as an escaped
    // backslash followed by a live quote.
    const p = proposal();
    p.marts[0].summaryTables = [stmt({ description: 'path\\to "x"' })];
    const yml = renderDbtScaffold(p).find((f) => f.path === 'models/schema.yml')!;
    expect(yml.contents).toContain('description: "path\\\\to \\"x\\""');
  });
});
