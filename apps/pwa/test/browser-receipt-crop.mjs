import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const assets = await readdir(new URL('../.cloudflare/output/v0/workers/default/assets/assets/', import.meta.url));
const moduleFile = assets.find(name => /^receipt-image-privacy-.*\.js$/.test(name));
const browser = await chromium.launch({ headless: true, executablePath: process.env.PWA_BROWSER_PATH, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await page.evaluate(async moduleFile => {
    const { prepareReceiptImage } = await import(`/assets/${moduleFile}`);
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 800;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 600, 800);
    context.fillStyle = '#f00'; context.fillRect(0, 0, 600, 100);
    context.fillStyle = '#000'; context.font = '26px sans-serif'; context.fillText('Phone: 090-1234-5678', 30, 160);
    const photo = await new Promise(resolve => canvas.toBlob(resolve));
    window.cropResult = prepareReceiptImage(photo, new AbortController().signal).then(async blob => {
      const bitmap = await createImageBitmap(blob); const output = document.createElement('canvas');
      output.width = bitmap.width; output.height = bitmap.height; const context = output.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
      return { width: output.width, height: output.height,
        top: [...context.getImageData(10, 10, 1, 1).data], mask: [...context.getImageData(240, 230, 1, 1).data],
        automatic: [...context.getImageData(100, 35, 1, 1).data] };
    });
  }, moduleFile);
  await page.getByRole('heading', { name: '送信する写真を確認' }).waitFor();
  assert.equal(await page.getByText(/数字で範囲を隠す/).count(), 0);
  const preview = page.locator('.receipt-mask-canvas');
  await preview.scrollIntoViewIfNeeded(); let box = await preview.boundingBox();
  await page.mouse.move(box.x + box.width * .4, box.y + box.height * .375); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .5); await page.mouse.up();
  const selectCrop = async () => {
    await click('トリミング'); await preview.scrollIntoViewIfNeeded(); box = await preview.boundingBox();
    for (const [name, x, y] of [['トリミング枠の左上', .1, .15], ['トリミング枠の右下', 5 / 6, 13 / 16]]) {
      const handle = page.getByRole('button', { name, exact: true });
      const position = await handle.boundingBox();
      await page.mouse.move(position.x + position.width / 2, position.y + position.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 3 }); await page.mouse.up();
    }
  };
  await selectCrop();
  assert.equal(await page.getByRole('button', { name: 'この写真で読み取る', exact: true }).isEnabled(), false);
  if (process.env.PWA_RECEIPT_CROP_SCREENSHOT_PATH) {
    await page.getByRole('dialog').evaluate(dialog => { dialog.scrollTop = 0; });
    await page.screenshot({ path: process.env.PWA_RECEIPT_CROP_SCREENSHOT_PATH });
  }
  await click('この範囲で切り取る');
  let size = await preview.evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
  assert.ok(Math.abs(size.width - 440) <= 2 && Math.abs(size.height - 530) <= 2, JSON.stringify(size));
  await click('切り取りを戻す');
  assert.deepEqual(await preview.evaluate(canvas => [canvas.width, canvas.height]), [600, 800]);
  await selectCrop();
  // Corner handles also support keyboard adjustment, replacing the old numeric UI.
  await page.getByRole('button', { name: 'トリミング枠の左上', exact: true }).press('ArrowRight');
  await click('この範囲で切り取る');
  size = await preview.evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
  await page.waitForFunction(() => !document.querySelector('.receipt-privacy-actions .primary').disabled);
  await click('この写真で読み取る');
  const output = await page.evaluate(() => window.cropResult);
  assert.equal(output.width, size.width); assert.equal(output.height, size.height);
  assert.deepEqual(output.top, [255, 255, 255, 255], 'outside the crop is removed, not shaded');
  assert.deepEqual(output.mask, [0, 0, 0, 255], 'manual mask remains aligned after crop/reset');
  assert.deepEqual(output.automatic, [0, 0, 0, 255], 'late automatic masks remain aligned after cropping');
  assert.deepEqual(errors, []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log('PASS: touch-sized corner handles, keyboard resize, crop/reset, send locking and cropped pixels with aligned manual/automatic masks');
} finally { await browser.close(); }
