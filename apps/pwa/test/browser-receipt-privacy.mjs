import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import qrcode from 'qrcode-generator';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated preview.');
const browser = await chromium.launch({ headless: true, executablePath: process.env.PWA_BROWSER_PATH, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
const page = await context.newPage();
const logs = [], failures = [], sent = [];
page.on('console', message => logs.push(message.text())); page.on('pageerror', error => failures.push(error.message));
await context.addInitScript(() => {
  window.receiptUrls = { created: [], revoked: [] };
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => { const url = create(blob); if (blob.type.startsWith("image/")) window.receiptUrls.created.push(url); return url; };
  URL.revokeObjectURL = url => { window.receiptUrls.revoked.push(url); revoke(url); };
});
await context.route('**/api/ai/token', route => route.fulfill({ json: { token: 'synthetic-token', expiresAt: 9999999999 } }));
let response = 'success', release;
await context.route('**/api/ai/gemini', async route => {
  sent.push(route.request().postDataJSON());
  if (response === 'held') await new Promise(resolve => { release = resolve; });
  if (response === 'failure') return route.fulfill({ status: 503, json: { error: 'provider_unavailable' } });
  return route.fulfill({ json: { documentKind: 'receipt', merchant: 'Synthetic Shop', purchasedDate: '2026-10-11', purchasedTime: null,
    totalAmountYen: 640, taxAmountYen: null, items: [{ name: 'Synthetic Bread', amountYen: 640 }], warnings: [] } }).catch(() => {});
});
await context.route('**/api/ai/jev', route => route.fulfill({ status: 503, json: { error: 'provider_unavailable' } }));
const click = name => page.getByRole('button', { name, exact: true }).click();
const noImages = async () => {
  assert.equal(await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('kakeimatch-local-data'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    let count = 0;
    for (const name of db.objectStoreNames) {
      const rows = await new Promise(resolve => { const request = db.transaction(name).objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); });
      count += rows.filter(row => row.ownerKind === 'receipt' && row.blob instanceof Blob).length;
    }
    db.close(); return count;
  }), 0);
  const cachesHaveReceipt = await page.evaluate(async () => {
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) {
      if (new URL(request.url).pathname.startsWith('/api/ai/') || request.url.startsWith('blob:')) return true;
    }
    return false;
  });
  assert.equal(cachesHaveReceipt, false);
};
try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0').waitFor();
  await page.locator('#settings-tab').click(); await click('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Wallet'); await click('追加する');
  await page.getByRole('button', { name: 'Synthetic Wallet · 利用中', exact: true }).waitFor();
  const qr = qrcode(0, 'M'); qr.addData('SYNTHETIC-PRIVATE-QR'); qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 8 });
  const photo = Buffer.from(await page.evaluate(async svg => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 850;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 850); ctx.fillStyle = '#000'; ctx.font = '26px sans-serif';
    ['Synthetic Shop', '2026-10-11', 'Phone: 090-1234-5678', 'Member ID: SYNTHETIC123', 'Card number: 4111111111111111',
      'Account number: 1234567', 'Address: Synthetic Street 123', 'Customer name: Synthetic Person', 'Synthetic Bread 640', 'Total 640'].forEach((line, i) => ctx.fillText(line, 30, 45 + i * 50));
    const img = new Image(); img.src = `data:image/svg+xml;base64,${btoa(svg)}`; await img.decode(); ctx.drawImage(img, 30, 560);
    for (let x = 270; x < 560; x += 4) ctx.fillRect(x, 570, 2, 100);
    return canvas.toDataURL('image/png').split(',')[1];
  }, svg), 'base64');
  const choose = async () => {
    await page.locator('#receipt-tab').click(); await click('記録を追加');
    await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic-private.png', mimeType: 'image/png', buffer: photo });
    await page.getByRole('button', { name: 'AIで読み取る', exact: true }).waitFor(); await noImages();
  };
  const review = async () => { await click('AIで読み取る'); await page.getByRole('heading', { name: '送信する写真を確認' }).waitFor({ timeout: 60000 }); await page.waitForFunction(() => !document.querySelector('.receipt-privacy-actions .primary')?.disabled); };
  await choose(); await click('AIで読み取る');
  await page.getByRole('heading', { name: '送信する写真を確認' }).waitFor();
  await page.getByLabel('上端（%）').fill('85'); await page.getByLabel('下端（%）').fill('90'); await click('この範囲を隠す');
  await page.waitForFunction(() => !document.querySelector('.receipt-privacy-actions .primary')?.disabled);
  assert.deepEqual(await page.locator('.receipt-mask-canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(300, canvas.height * .87, 1, 1).data]), [0, 0, 0, 255], 'manual masks survive later detection results');
  await click('1つ戻す');
  assert.equal(sent.length, 0, 'Review must precede external dispatch');
  assert.equal(await page.getByText('自動検出できなかった箇所があります。', { exact: false }).count(), 0);
  const bands = await page.locator('.receipt-mask-canvas').evaluate(canvas => {
    const ctx = canvas.getContext('2d'); const result = [];
    for (const y of [130, 180, 230, 280, 330, 380, 600]) {
      let black = 0; for (let x = 30; x < 550; x++) { const data = ctx.getImageData(x, y, 1, 1).data; if (data[0] === 0 && data[1] === 0 && data[2] === 0) black++; }
      result.push(black);
    }
    return result;
  });
  assert.ok(bands.every(count => count > 80), 'All labeled private fields and codes must be masked');
  await page.getByLabel('上端（%）').fill('85'); await page.getByLabel('下端（%）').fill('90'); await click('この範囲を隠す'); await click('1つ戻す');
  await page.getByRole('dialog').evaluate(dialog => { dialog.scrollTop = 0; });
  if (process.env.PWA_RECEIPT_PRIVACY_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RECEIPT_PRIVACY_SCREENSHOT_PATH });
  await click('この写真で読み取る');
  await page.waitForFunction(() => document.querySelector('#receipt-merchant')?.value === 'Synthetic Shop');
  assert.equal(sent.length, 1); assert.notEqual(sent[0].imageBase64, photo.toString('base64'));
  await noImages();
  assert.equal(await page.locator('.receipt-preview-open').count(), 0);
  assert.ok(await page.evaluate(() => window.receiptUrls.created.every(url => window.receiptUrls.revoked.includes(url))));

  response = 'failure'; await choose(); await review(); await click('この写真で読み取る');
  await page.locator('.reading-failure:not([hidden])').waitFor(); await noImages();
  assert.equal(await page.locator('.receipt-preview-open').count(), 0);
  // Cancellation before dispatch does not send an image.
  await choose(); await review(); const before = sent.length; await page.getByRole('dialog').getByRole('button', { name: 'キャンセル', exact: true }).click();
  await page.locator('.reading-failure:not([hidden])').waitFor(); assert.equal(sent.length, before); await noImages();
  // Cancellation after dispatch discards the photo and ignores a late response.
  response = 'held'; await choose(); await review(); await click('この写真で読み取る');
  await page.waitForFunction(() => document.querySelector('.receipt-mask-canvas') === null);
  while (!release) await new Promise(resolve => setTimeout(resolve, 20));
  await click('待たずに手で入力する'); await noImages(); release();
  assert.equal(await page.locator('.receipt-preview-open').count(), 0);
  assert.equal(await page.locator('#receipt-merchant').inputValue(), '');
  // Navigating away before reading also releases the photo, leaving only the empty draft.
  await choose(); await page.locator('#home-tab').click(); await noImages();
  assert.ok(await page.evaluate(() => window.receiptUrls.created.every(url => window.receiptUrls.revoked.includes(url))));
  assert.equal(failures.length, 0);
  assert.ok(logs.every(line => !/SYNTHETIC123|4111111111111111|090-1234-5678|SYNTHETIC-PRIVATE-QR/.test(line)));
  console.log('PASS: local OCR, QR/barcode masks, reviewed dispatch, success/failure/cancellation/navigation cleanup, no persistent images, URL revocation and safe logs');
} finally { await browser.close(); }
