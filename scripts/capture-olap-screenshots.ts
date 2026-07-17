/**
 * Capture OLAP-feature screenshots for docs (anomaly/drift depth, data monitor,
 * investigate mode, BigQuery cost-safety connection form). Chromium via Playwright
 * against the running dev server. Uses the existing "Demo — Online Shop" sqlite
 * connection (no BigQuery bytes billed — the BQ shot is the connection FORM only).
 *
 * Env: UI_BASE (default http://localhost:3000), DEMO_CONN_ID, SHOT_DIR.
 */
import { chromium, type Page } from 'playwright';

const BASE = process.env.UI_BASE ?? 'http://localhost:3000';
const CONN = process.env.DEMO_CONN_ID!;
const SHOTS = process.env.SHOT_DIR ?? '.tmp/olap-shots';

const shot = (p: Page, n: string) => p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
const log = (m: string) => console.log('  •', m);

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // 1) Data Health — anomaly (MAD) check on a real numeric column.
  log('health / anomaly');
  await page.goto(`${BASE}/db/${CONN}/schema/health`, { waitUntil: 'networkidle' });
  await page.getByTestId('anomaly-check').waitFor({ timeout: 15000 });
  // Click the first column's anomaly button and wait for the report to render.
  const firstCol = page.getByTestId('anomaly-check').getByRole('button').first();
  await firstCol.click();
  // Report text includes "Robust (MAD)" from the new depth work; wait for it.
  await page.getByText(/Robust \(MAD\)|outlier|σ/i).first().waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  await shot(page, 'anomaly-health');

  // 2) Automations — Data monitor config (drift snapshot-diff).
  log('automations / data monitor');
  await page.goto(`${BASE}/db/${CONN}/automations`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Data monitor/i }).click();
  await page.getByTestId('monitor-config').waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  await shot(page, 'data-monitor');

  // 3) Investigate mode — a multi-step agentic analysis turn.
  log('chat / investigate');
  await page.goto(`${BASE}/db/${CONN}/chat`, { waitUntil: 'networkidle' });
  const box = page.getByRole('textbox').last();
  await box.fill('Investigate revenue by order status and flag anything unusual.');
  // Turn on investigate mode if a toggle is present, then send.
  const investigateToggle = page.getByRole('button', { name: /Investigate/i }).first();
  if (await investigateToggle.count()) await investigateToggle.click().catch(() => {});
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // Let the agent stream a few steps; wait for assistant content, cap the wait.
  await page.waitForTimeout(12000);
  await shot(page, 'investigate-mode');

  // 4) BigQuery connection form — cost-safety fields (budget + per-query cap).
  log('connections / BigQuery cost-safety form');
  await page.goto(`${BASE}/connections`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /BigQuery/i }).click();
  // The BQ fields (project id, service-account, daily budget, per-query cap) render.
  await page.getByPlaceholder(/GCP project ID/i).waitFor({ timeout: 8000 });
  await page.waitForTimeout(400);
  await shot(page, 'bigquery-cost-safety');

  await browser.close();
  console.log('\nDone. Shots in', SHOTS);
}

main().catch((e) => { console.error(e); process.exit(1); });
