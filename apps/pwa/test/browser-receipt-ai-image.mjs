import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated test preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const sent = [];
await context.route('**/api/ai/token', route => route.fulfill({ json: { token: 'synthetic-token', expiresAt: 9999999999 } }));
await context.route('**/api/ai/gemini', route => {
  sent.push(route.request().postDataJSON());
  return route.fulfill({ json: { documentKind: 'receipt', merchant: 'Synthetic Image Shop', purchasedDate: '2026-09-30', purchasedTime: null, totalAmountYen: 500, taxAmountYen: null, items: [], warnings: [] } });
});
await context.route('**/api/ai/jev', route => route.fulfill({ status: 503, json: { error: 'provider_unavailable' } }));
const decodedSize = body => page.evaluate(async ({ contentType, imageBase64 }) => {
  // The app CSP blocks fetching data: URLs, so decode the Base64 bytes directly.
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(imageBase64), char => char.charCodeAt(0))], { type: contentType }));
  return { width: bitmap.width, height: bitmap.height };
}, body);
async function readReceipt(png) {
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: '記録を追加', exact: true }).click();
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'AIで読み取る', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#receipt-merchant')?.value === 'Synthetic Image Shop');
  return sent.at(-1);
}
try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0').waitFor();
  // Synthetic portrait photo larger than the AI copy needs.
  const large = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 3000; canvas.height = 4000;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 3000, 4000);
    context.fillStyle = '#000'; context.font = '120px sans-serif'; context.fillText('SYNTHETIC 500', 200, 400);
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  const reduced = await readReceipt(large);
  assert.equal(reduced.contentType, 'image/jpeg');
  assert.deepEqual(await decodedSize(reduced), { width: 1536, height: 2048 });
  const small = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64');
  const unchanged = await readReceipt(small);
  assert.equal(unchanged.contentType, 'image/png');
  assert.equal(unchanged.imageBase64, small.toString('base64'));
  assert.deepEqual(errors, []);
  console.log('Receipt AI image E2E passed.');
} finally {
  await browser.close();
}
