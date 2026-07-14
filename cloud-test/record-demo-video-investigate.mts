/** One-off: record a product demo video for Investigate mode (multi-step root-cause chat), Demo shop DB only. */
import { chromium, type Page } from 'playwright';

const BASE = 'http://localhost:3000';
const j = (r: Response) => r.json();
const VIDEO_DIR = 'cloud-test/demo-video-investigate';
const CHAT_INPUT = 'input[placeholder*="How many rows"], input[placeholder*="Why did activity"]';
const INVESTIGATE_TOGGLE = 'label:has-text("Investigate") input[type="checkbox"]';
const DEEP_TOGGLE = '[data-testid="deep-toggle"] input[type="checkbox"]';
const SEND_BTN = 'button[type="submit"]:has-text("Send")';

async function typeSlowly(locator: import('playwright').Locator, text: string) {
  await locator.click();
  await locator.pressSequentially(text, { delay: 40 });
}

/** Ask an investigate-mode question: wait for the plan block to show the multi-step breakdown on camera, then wait for the run to fully finish (Send re-enabled). */
async function askInvestigate(page: Page, question: string, opts: { deep?: boolean; hold?: number } = {}) {
  if (opts.deep) {
    await page.locator(DEEP_TOGGLE).check();
    await page.waitForTimeout(500);
  }
  const input = page.locator(CHAT_INPUT);
  await typeSlowly(input, question);
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  await page.locator(SEND_BTN).waitFor({ state: 'disabled', timeout: 15000 }).catch(() => {});
  // Let the plan block render if the model emits one (best-effort — not all runs do).
  await page.locator('text=📋 Analysis plan').first().waitFor({ timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  // Investigate mode runs a multi-step tool loop (plan -> multiple SQL runs -> self-repair);
  // this can take several minutes, far longer than a single chat turn.
  await page.locator(SEND_BTN + ':not([disabled])').waitFor({ timeout: 480000 });
  await page.waitForTimeout(opts.hold ?? 3500);
}

const conns = await j(await fetch(`${BASE}/api/connections`));
const demo = conns.find((c: { name: string }) => c.name.startsWith('Demo'));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
const hidePortal = () => page.evaluate(() => document.querySelector('nextjs-portal')?.remove());

await page.goto(`${BASE}/db/${demo.id}/chat`, { waitUntil: 'networkidle' });
await hidePortal();
await page.waitForTimeout(1200);

// Turn on Investigate mode on camera — placeholder swaps to the root-cause prompt.
await page.locator(INVESTIGATE_TOGGLE).check();
await page.waitForTimeout(1800);

// Investigate scene 1 — status breakdown root-cause style question (validated schema: orders.ord_sts_cd).
await askInvestigate(page, 'Vì sao số đơn hàng bị huỷ hoặc trả hàng lại cao, nguyên nhân do đâu?', { hold: 4000 });

// New turn, fresh page load to reset conversation state for a clean second scene.
await page.goto(`${BASE}/db/${demo.id}/chat`, { waitUntil: 'networkidle' });
await hidePortal();
await page.waitForTimeout(1000);
await page.locator(INVESTIGATE_TOGGLE).check();
await page.waitForTimeout(1200);

// Investigate scene 2 — customer segment revenue root-cause, same style, different angle.
await askInvestigate(page, 'Phân khúc khách hàng nào đang sụt giảm đóng góp doanh thu, vì sao?', { hold: 4000 });

// Investigate + Deep scene — toggle Deep on camera for the ~2x budget deep-dive mode.
await page.goto(`${BASE}/db/${demo.id}/chat`, { waitUntil: 'networkidle' });
await hidePortal();
await page.waitForTimeout(1000);
await page.locator(INVESTIGATE_TOGGLE).check();
await page.waitForTimeout(1000);
await askInvestigate(page, 'Phương thức thanh toán nào có tỉ lệ đơn thất bại/huỷ cao bất thường, phân tích sâu giúp tôi', { deep: true, hold: 4500 });

await page.waitForTimeout(1000);
await context.close();
await browser.close();
console.log('recording done, dir:', VIDEO_DIR);
