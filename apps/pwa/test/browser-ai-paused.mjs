import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const errors = [];
const geminiRequests = [];
const jevRequests = [];
let geminiPaused = true;
await context.route('**/api/auth/get-session', route => route.fulfill({ json: null }));
await context.route('**/api/ai/usage', route => route.fulfill({ status: 401, json: { error: 'synthetic_signed_out' } }));
await context.route('**/api/ai/token', route => route.fulfill({ json: { token: 'synthetic-token', expiresAt: Math.floor(Date.now() / 1000) + 600 } }));
await context.route('**/api/ai/gemini', async route => {
  const body = route.request().postDataJSON();
  geminiRequests.push(body);
  if (geminiPaused) return route.fulfill({ status: 503, json: { error: 'ai_temporarily_paused' } });
  return route.fulfill({ json: { documentKind: 'receipt', merchant: 'Extracted Provider Store', purchasedDate: '2026-10-01', purchasedTime: '12:00', totalAmountYen: 2400, taxAmountYen: null, items: [], warnings: [] } });
});
await context.route('**/api/ai/jev', async route => {
  jevRequests.push(route.request().postDataJSON());
  return route.fulfill({ status: 503, json: { error: 'ai_temporarily_paused' } });
});

const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-01T03:00:00Z'));
page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();
const syntheticPng = {
  name: 'synthetic-receipt.png', mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64'),
};

async function chooseReceiptEntry() {
  await page.locator('#home-tab').click();
  await click('記録を追加');
}

async function uploadReceipt(name = syntheticPng.name) {
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ ...syntheticPng, name });
  await page.locator('#receipt-merchant').waitFor();
  await page.locator('img.receipt-preview').waitFor();
}

async function enterReceipt(merchant, amount) {
  await page.locator('#receipt-merchant').fill(merchant);
  await page.locator('#receipt-date').fill('2026-10-01');
  await page.locator('#receipt-amount').fill(String(amount));
  await page.locator('#receipt-category').selectOption({ label: '食費' });
  await page.locator('#receipt-account').selectOption({ label: 'Synthetic Wallet' });
}

try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0', { exact: false }).waitFor();
  await page.locator('#settings-tab').click();
  await click('支払元');
  await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Wallet');
  await click('追加する');
  await page.getByRole('button', { name: 'Synthetic Wallet · 利用中', exact: true }).waitFor();
  await page.locator('#settings-tab').click();
  await click('カテゴリ');

  // Gemini pause: the image stays on the device and the user can complete registration by hand.
  await chooseReceiptEntry();
  await uploadReceipt();
  await enterReceipt('Gemini Draft Store', 1200);
  await click('AIで読み取る');
  await page.getByText('AI機能は一時的に利用できません。レシート画像と入力内容は端末に残っています。手入力で登録できます。時間をおいて再度お試しください。', { exact: true }).waitFor();
  assert.equal(await page.locator('img.receipt-preview').count(), 1);
  assert.equal(await page.locator('#receipt-merchant').inputValue(), 'Gemini Draft Store');
  assert.equal(await page.locator('#receipt-amount').inputValue(), '1200');
  if (process.env.PWA_AI_PAUSED_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_AI_PAUSED_SCREENSHOT_PATH, fullPage: true });
  await click('登録する');
  await page.getByText('登録しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: /^Gemini Draft Store · .*レシート/ }).waitFor();

  // Jev pause: Gemini extraction remains available to edit, and registration does not need a cloud session.
  await chooseReceiptEntry();
  await uploadReceipt('synthetic-jev-paused.png');
  await enterReceipt('Jev Paused Manual Store', 1800);
  geminiPaused = false;
  await click('AIで読み取る');
  await page.getByText('AI機能は一時的に利用できません。レシート画像と入力内容は端末に残っています。手入力で登録できます。時間をおいて再度お試しください。 読み取った内容は編集できます。', { exact: true }).waitFor();
  assert.equal(await page.locator('#receipt-merchant').inputValue(), 'Extracted Provider Store');
  assert.equal(await page.locator('img.receipt-preview').count(), 1);
  await enterReceipt('Jev Paused Corrected Store', 1900);
  await click('登録する');
  await page.getByText('登録しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: /^Jev Paused Corrected Store · .*レシート/ }).waitFor();

  assert.equal(geminiRequests.length, 2);
  assert.equal(jevRequests.length, 1);
  assert.deepEqual(errors, []);
  await page.locator('#home-tab').click();
  await page.getByText('今月の支出 ¥3,100', { exact: false }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log('PASS: Gemini/Jev 503 pauses show a safe message, local receipt images remain available, and manual registration works without an account session at 375px width');
} catch (error) {
  console.log(await page.locator('body').innerText());
  console.log('Mock calls:', { gemini: geminiRequests.length, jev: jevRequests.length, status: await page.locator('#message').textContent().catch(() => null) });
  throw error;
} finally { await browser.close(); }
