import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const assets = await readdir(new URL('../.cloudflare/output/v0/workers/default/assets/assets/', import.meta.url));
const moduleFile = assets.find(name => /^receipt-image-privacy-.*\.js$/.test(name));
assert.ok(moduleFile);
const browser = await chromium.launch({ headless: true, executablePath: process.env.PWA_BROWSER_PATH, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
const page = await context.newPage();
const session = await context.newCDPSession(page);
await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
let release;
const blocked = new Promise(resolve => { release = resolve; });
await context.route('**/receipt-ocr/**', async route => { await blocked; await route.abort().catch(() => {}); });
try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0').waitFor();
  await page.evaluate(async moduleFile => {
    const { prepareReceiptImage } = await import(`/assets/${moduleFile}`);
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 2000;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000'; context.font = '40px sans-serif'; context.fillText('Synthetic Shop', 40, 80);
    for (let x = 50; x < 1000; x += 8) context.fillRect(x, 1600, 4, 160);
    const photo = await new Promise(resolve => canvas.toBlob(resolve));
    window.responseStarted = performance.now();
    window.responseController = new AbortController();
    window.responseResult = prepareReceiptImage(photo, window.responseController.signal).then(() => 'sent', error => error.name);
  }, moduleFile);
  await page.getByRole('heading', { name: '送信する写真を確認' }).waitFor({ timeout: 2000 });
  const elapsed = await page.evaluate(() => performance.now() - window.responseStarted);
  assert.ok(elapsed < 2000, `Review took ${Math.round(elapsed)}ms while local detection was pending`);
  assert.equal(await page.getByRole('button', { name: 'この写真で読み取る', exact: true }).isEnabled(), false);
  const preview = page.locator('.receipt-mask-canvas');
  await preview.scrollIntoViewIfNeeded();
  const box = await preview.boundingBox();
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * .3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .7, box.y + box.height * .6, { steps: 4 });
  assert.deepEqual(await preview.evaluate(async canvas => {
    await new Promise(requestAnimationFrame);
    return [...canvas.getContext('2d').getImageData(canvas.width * .4, canvas.height * .4, 1, 1).data];
  }), [0, 0, 0, 255], 'drag must paint before the finger is lifted');
  await page.mouse.up();
  if (process.env.PWA_RECEIPT_RESPONSE_SCREENSHOT_PATH) {
    await page.getByRole('dialog').evaluate(dialog => { dialog.scrollTop = 0; });
    await page.screenshot({ path: process.env.PWA_RECEIPT_RESPONSE_SCREENSHOT_PATH });
  }
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  assert.equal(await page.evaluate(() => window.responseResult), 'AbortError');
  assert.equal(await page.locator('.receipt-privacy-dialog').count(), 0);
  release();
  console.log(`PASS: review opens in ${Math.round(elapsed)}ms during blocked detection; drag paints before release; send stays disabled; cancel responds immediately`);
} finally { release(); await browser.close(); }
