import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated test preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-09-30T03:00:00Z'));
const errors = []; page.on('pageerror', error => errors.push(error.message));
let releaseJev, jevArrived;
const jevSeen = new Promise(resolve => { jevArrived = resolve; });
await context.route('**/api/ai/token', route => route.fulfill({ json: { token: 'synthetic-token', expiresAt: 9999999999 } }));
await context.route('**/api/ai/gemini', route => route.fulfill({ json: { documentKind: 'receipt', merchant: 'Synthetic Later Shop', purchasedDate: '2026-09-30', purchasedTime: '12:00', totalAmountYen: 800, taxAmountYen: null, items: [{ name: 'Synthetic Bread', amountYen: 300 }, { name: 'Synthetic Detergent', amountYen: 500 }], warnings: [] } }));
await context.route('**/api/ai/jev', async route => {
  // Hold the category answer so the test can act while it is pending.
  const released = new Promise(resolve => { releaseJev = resolve; });
  jevArrived();
  await released;
  const body = route.request().postDataJSON();
  const food = body.categories.find(entry => entry.name === '食費');
  const answers = Object.fromEntries(body.itemIndexes.map(index => [`item_${index}`, { type: 'choice', choice: food.id, confidence: 1, probabilities: Object.fromEntries(body.categories.map(entry => [entry.id, entry.id === food.id ? 1 : 0])) }]));
  await route.fulfill({ json: { model: 'synthetic-model', answers } });
});
const click = name => page.getByRole('button', { name, exact: true }).click();
const itemCategory = index => page.locator('[data-receipt-item]').nth(index).locator('[data-item-category]');
try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0').waitFor();
  await page.locator('#settings-tab').click(); await click('カテゴリ'); await click('基本カテゴリを用意する');
  await page.getByText('基本カテゴリを用意しました。', { exact: true }).waitFor();
  await page.locator('#receipt-tab').click();
  await click('記録を追加');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64') });
  await click('AIで読み取る');
  // The read values appear before the category suggestion returns.
  await page.getByText('カテゴリを提案しています…', { exact: true }).waitFor();
  assert.equal(await page.locator('#receipt-merchant').inputValue(), 'Synthetic Later Shop');
  assert.equal(await page.locator('#receipt-amount').inputValue(), '800');
  assert.ok(await page.getByRole('button', { name: '登録する', exact: true }).isDisabled(), 'Registration waits for the category suggestion.');
  if (process.env.PWA_RECEIPT_AI_CATEGORIES_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RECEIPT_AI_CATEGORIES_SCREENSHOT_PATH });
  assert.ok(await page.locator('#receipt-merchant').isEnabled(), 'Read values stay editable while categories load.');
  // A choice made while waiting is kept; only empty categories are filled.
  await page.locator('#receipt-merchant').fill('Synthetic Edited Shop');
  await page.locator('[data-receipt-item]').nth(1).locator('summary').click();
  await itemCategory(1).selectOption({ label: '日用品' });
  await jevSeen;
  releaseJev();
  await page.getByText('カテゴリを提案しています…', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(await itemCategory(0).locator('option:checked').textContent(), '食費');
  assert.equal(await itemCategory(1).locator('option:checked').textContent(), '日用品');
  assert.equal(await page.locator('#receipt-merchant').inputValue(), 'Synthetic Edited Shop');
  assert.ok(await page.getByRole('button', { name: '登録する', exact: true }).isEnabled());
  assert.deepEqual(errors, []);
  console.log('PASS: read values appear before categories, registration waits, and choices made while waiting are kept.');
} finally {
  await browser.close();
}
