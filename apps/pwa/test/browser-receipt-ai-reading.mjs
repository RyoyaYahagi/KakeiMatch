import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated test preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
// Hold each AI answer so the test can look at the screen while it waits.
const held = {};
const hold = name => new Promise(resolve => { held[name] = resolve; });
let geminiSeen, jevSeen;
const geminiArrived = new Promise(resolve => { geminiSeen = resolve; });
const jevArrived = new Promise(resolve => { jevSeen = resolve; });
await context.route('**/api/ai/token', route => route.fulfill({ json: { token: 'synthetic-token', expiresAt: 9999999999 } }));
await context.route('**/api/ai/gemini', async route => {
  const released = hold('gemini'); geminiSeen(); await released;
  await route.fulfill({ json: { documentKind: 'receipt', merchant: 'Synthetic Reading Shop', purchasedDate: '2026-10-04', purchasedTime: null, totalAmountYen: 640, taxAmountYen: null, items: [{ name: 'Synthetic Bread', amountYen: 640 }], warnings: [] } });
});
await context.route('**/api/ai/jev', async route => {
  const released = hold('jev'); jevSeen(); await released;
  await route.fulfill({ status: 503, json: { error: 'provider_unavailable' } });
});
const click = name => page.getByRole('button', { name, exact: true }).click();
try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0').waitFor();
  await page.locator('#settings-tab').click(); await click('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Wallet'); await click('追加する');
  await page.getByRole('button', { name: 'Synthetic Wallet · 利用中', exact: true }).waitFor();
  await page.locator('#receipt-tab').click();
  await click('記録を追加');
  // A synthetic receipt-like photo, so the reading motion over the image is visible.
  const photo = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 720;
    const context = canvas.getContext('2d'); context.fillStyle = '#f4f1ea'; context.fillRect(0, 0, 480, 720);
    context.fillStyle = '#333'; context.font = '28px sans-serif'; context.fillText('SYNTHETIC SHOP', 120, 70);
    context.font = '20px sans-serif';
    for (let line = 0; line < 14; line += 1) { context.fillText(`Synthetic item ${line + 1}`, 40, 140 + line * 36); context.fillText(`${(line + 1) * 100}`, 380, 140 + line * 36); }
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: photo });
  await click('AIで読み取る');
  await geminiArrived;
  // While reading: the step, elapsed seconds, the usual wait, motion on the photo and placeholder bands.
  await page.locator('.receipt-reading-title').filter({ hasText: /^内容を読み取っています（\d+秒）$/ }).waitFor();
  assert.match(await page.locator('.receipt-reading-hint').textContent(), /通常5秒ほどかかります/);
  assert.equal(await page.getByRole('status').filter({ hasText: '内容を読み取っています' }).count(), 1);
  assert.equal(await page.locator('.receipt-preview-frame.is-reading').count(), 1);
  // The robot follows the step and is hidden from screen readers.
  assert.equal(await page.locator('.receipt-reading').getAttribute('data-step'), 'reading');
  assert.equal(await page.locator('.receipt-reading .reading-robot').getAttribute('aria-hidden'), 'true');
  assert.ok(await page.getByRole('button', { name: 'AIで読み取る', exact: true }).isHidden(), 'The read button is hidden while reading');
  for (const id of ['#receipt-amount', '#receipt-merchant', '#receipt-date']) {
    assert.ok(await page.locator(id).isDisabled(), `${id} waits for the read`);
    assert.match(await page.locator(id).getAttribute('class'), /ai-pending/);
  }
  // The payment source is not filled by AI, so it can be chosen while waiting.
  assert.ok(await page.locator('#receipt-account').isEnabled());
  await page.locator('#receipt-account').selectOption({ label: 'Synthetic Wallet' });
  // Freeze the band over the middle of the photo so the screenshot shows the motion.
  if (process.env.PWA_RECEIPT_AI_READING_SCREENSHOT_PATH) {
    const pause = await page.addStyleTag({ content: '.receipt-preview-frame.is-reading::after { animation-delay: -0.9s !important; animation-play-state: paused !important; }' });
    await page.screenshot({ path: process.env.PWA_RECEIPT_AI_READING_SCREENSHOT_PATH });
    await pause.evaluate(node => node.remove());
  }
  held.gemini();
  await jevArrived;
  await page.locator('.receipt-reading-title').filter({ hasText: /^カテゴリを提案しています（\d+秒）$/ }).waitFor();
  assert.equal(await page.locator('.receipt-reading').getAttribute('data-step'), 'categorizing');
  if (process.env.PWA_RECEIPT_AI_CATEGORIZING_SCREENSHOT_PATH) await page.locator('.receipt-reading').screenshot({ path: process.env.PWA_RECEIPT_AI_CATEGORIZING_SCREENSHOT_PATH });
  held.jev();
  await page.getByText(/読み取った内容は編集できます/).waitFor();
  assert.equal(await page.locator('.receipt-reading').count(), 0);
  assert.equal(await page.locator('.receipt-preview-frame.is-reading').count(), 0);
  assert.equal(await page.locator('#receipt-merchant').inputValue(), 'Synthetic Reading Shop');
  assert.doesNotMatch(await page.locator('#receipt-amount').getAttribute('class') ?? '', /ai-pending/);
  // The payment source chosen while waiting is kept after the read.
  assert.equal(await page.locator('#receipt-account option:checked').textContent(), 'Synthetic Wallet');
  assert.deepEqual(errors, []);
  console.log('PASS: reading shows the step with elapsed seconds, the robot, motion and placeholder bands, keeps the payment source selectable and kept, and clears when done.');
} finally {
  await browser.close();
}
