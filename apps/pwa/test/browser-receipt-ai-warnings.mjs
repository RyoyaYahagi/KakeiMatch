import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated test preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-04T03:00:00Z'));
const errors = []; page.on('pageerror', error => errors.push(error.message));
await context.route('**/api/ai/token', route => route.fulfill({ json: { token: 'synthetic-token', expiresAt: 9999999999 } }));
await context.route('**/api/ai/gemini', route => route.fulfill({ json: {
  documentKind: 'receipt', merchant: 'Synthetic Net Market', purchasedDate: '2026-10-04', purchasedTime: null, totalAmountYen: 0, taxAmountYen: null,
  items: [{ name: 'Synthetic Rice', amountYen: 400 }, { name: 'Synthetic Lettuce', amountYen: 0 }, { name: 'Synthetic Chicken', amountYen: 600 }],
  adjustments: [{ label: 'Synthetic Coupon', amountYen: -100 }],
  warnings: [
    { field: 'items', code: 'out_of_stock', message: '欠品のため金額が0円になっています。', index: 1 },
    { field: 'totalAmountYen', code: 'points', message: 'ポイント利用で支払額が0円です。', index: null },
    { field: null, code: 'layout', message: 'Unusual document layout' },
  ],
} }));
await context.route('**/api/ai/jev', route => route.fulfill({ status: 503, json: { error: 'provider_unavailable' } }));
const click = name => page.getByRole('button', { name, exact: true }).click();
try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0').waitFor();
  await page.locator('#receipt-tab').click();
  await click('記録を追加');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64') });
  await click('AIで読み取る');
  const band = page.getByRole('region', { name: '画像と照らし合わせてほしいところが3件あります' });
  await band.waitFor();
  const rows = band.getByRole('button');
  assert.equal(await rows.count(), 3);
  assert.match(await rows.nth(0).textContent(), /品目2「Synthetic Lettuce」.*欠品のため金額が0円になっています。/);
  assert.match(await rows.nth(1).textContent(), /合計金額.*ポイント利用で支払額が0円です。/);
  // A message that is not Japanese is replaced with a plain instruction.
  assert.match(await rows.nth(2).textContent(), /レシート全体.*画像の内容と照らし合わせてください。/);
  // The place is marked with words, not only color.
  assert.equal(await page.locator('#receipt-amount-review').textContent(), '△ 要確認');
  assert.equal(await page.locator('#receipt-amount').getAttribute('aria-describedby'), 'receipt-amount-review');
  assert.match(await page.locator('[data-receipt-item]').nth(1).locator('.receipt-compact-meta').textContent(), /^△ 要確認 · /);
  assert.doesNotMatch(await page.locator('[data-receipt-item]').nth(0).locator('.receipt-compact-meta').textContent(), /要確認/);
  if (process.env.PWA_RECEIPT_AI_WARNINGS_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RECEIPT_AI_WARNINGS_SCREENSHOT_PATH });
  // Each row moves to the place it is about.
  await rows.nth(0).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-receipt-item]')[1]?.open === true);
  assert.equal(await page.locator('[data-receipt-item]').nth(1).locator('[data-item-name]').evaluate(node => node === document.activeElement), true);
  await page.getByRole('button', { name: '全体', exact: true }).click();
  await rows.nth(1).click();
  await page.waitForFunction(() => document.activeElement?.id === 'receipt-amount');
  assert.deepEqual(errors, []);
  console.log('PASS: read warnings name the place and reason, mark fields with words, replace non-Japanese messages, and move to each place.');
} finally {
  await browser.close();
}
