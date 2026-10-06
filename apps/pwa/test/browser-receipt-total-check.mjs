import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated test preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
await context.route('**/api/ai/token', route => route.fulfill({ json: { token: 'synthetic-token', expiresAt: 9999999999 } }));
await context.route('**/api/ai/gemini', route => route.fulfill({ json: {
  documentKind: 'receipt', merchant: 'Synthetic Check Shop', purchasedDate: '2026-10-04', purchasedTime: null, totalAmountYen: 900, taxAmountYen: null,
  items: [{ name: 'Synthetic Bread', amountYen: 400 }, { name: 'Synthetic Milk', amountYen: 600 }],
  adjustments: [{ label: 'Synthetic Coupon', amountYen: -100 }], warnings: [],
} }));
await context.route('**/api/ai/jev', route => route.fulfill({ status: 503, json: { error: 'provider_unavailable' } }));
const click = name => page.getByRole('button', { name, exact: true }).click();
try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0').waitFor();
  await page.locator('#receipt-tab').click();
  await click('記録を追加');
  // A tall synthetic receipt photo, so zooming and scrolling are visible.
  const photo = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 1400;
    const context = canvas.getContext('2d'); context.fillStyle = '#f4f1ea'; context.fillRect(0, 0, 600, 1400);
    context.fillStyle = '#333'; context.font = '32px sans-serif'; context.fillText('SYNTHETIC CHECK SHOP', 110, 80);
    context.font = '26px sans-serif'; context.fillText('Synthetic Bread', 50, 200); context.fillText('400', 480, 200);
    context.fillText('Synthetic Milk', 50, 250); context.fillText('600', 480, 250); context.fillText('Coupon', 50, 300); context.fillText('-100', 470, 300);
    context.font = 'bold 34px sans-serif'; context.fillText('TOTAL', 50, 1200); context.fillText('900', 470, 1200);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: photo });
  await click('AIで読み取る');
  await page.waitForFunction(() => document.querySelector('#receipt-merchant')?.value === 'Synthetic Check Shop');
  // Items and adjustments add up to the total, so only the total needs comparing.
  const check = page.locator('#receipt-total-check');
  assert.equal(await check.textContent(), '✓ 一致');
  assert.equal(await check.getAttribute('aria-label'), '品目と値引きの合計と一致');
  assert.match(await check.getAttribute('class'), /is-match/);
  if (process.env.PWA_RECEIPT_TOTAL_CHECK_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RECEIPT_TOTAL_CHECK_SCREENSHOT_PATH });
  await page.locator('#receipt-amount').fill('950');
  assert.equal(await check.textContent(), '△ 差額あり');
  assert.equal(await check.getAttribute('aria-label'), '品目と値引きの合計と¥50違います');
  assert.match(await check.getAttribute('class'), /is-mismatch/);
  await page.locator('#receipt-amount').fill('900');
  // The photo opens full screen; a tap zooms into that spot and another tap fits it again.
  await click('レシート画像を拡大して見る');
  const viewer = page.getByRole('dialog', { name: 'レシート画像' });
  await viewer.waitFor();
  const image = viewer.locator('img');
  const fitted = await image.boundingBox();
  await image.click({ position: { x: fitted.width * 0.8, y: fitted.height * 0.85 } });
  await page.waitForFunction(() => document.querySelector('.receipt-image-viewer')?.classList.contains('is-zoomed'));
  const zoomed = await image.boundingBox();
  assert.ok(zoomed.width > fitted.width * 2, 'the photo is zoomed');
  const stage = await page.evaluate(() => { const node = document.querySelector('.receipt-image-viewer-stage'); return { left: node.scrollLeft, top: node.scrollTop }; });
  assert.ok(stage.left > 0 && stage.top > 0, 'the tapped point is scrolled into view');
  if (process.env.PWA_RECEIPT_ZOOM_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RECEIPT_ZOOM_SCREENSHOT_PATH });
  await image.click();
  await page.waitForFunction(() => !document.querySelector('.receipt-image-viewer')?.classList.contains('is-zoomed'));
  await viewer.getByRole('button', { name: '閉じる', exact: true }).click();
  await viewer.waitFor({ state: 'detached' });
  assert.equal(await page.locator('#receipt-amount').inputValue(), '900');
  assert.deepEqual(errors, []);
  console.log('PASS: a total that matches items is confirmed, a mismatch shows the difference, and the photo opens full screen with tap zoom.');
} finally {
  await browser.close();
}
