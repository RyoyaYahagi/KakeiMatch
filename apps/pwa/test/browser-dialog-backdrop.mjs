import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
try {
  for (const width of [375, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true });
    await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
    await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const click = name => page.getByRole('button', { name, exact: true }).click();
    const outside = async dialog => {
      const box = await dialog.boundingBox();
      const point = { x: width / 2, y: box.y > 4 ? box.y / 2 : box.y + box.height + 4 };
      await page.touchscreen.tap(point.x, point.y);
    };
    const remainsOpen = async dialog => {
      // Bare padding belongs to the dialog: event.target === dialog is not sufficient.
      const box = await dialog.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + 2);
      assert.equal(await dialog.evaluate(node => node.open), true);
      // Dragging out from the content must not turn into a backdrop dismissal.
      await page.mouse.move(box.x + box.width / 2, box.y + 2);
      await page.mouse.down(); await page.mouse.move(width / 2, box.y / 2); await page.mouse.up();
      assert.equal(await dialog.evaluate(node => node.open), true);
    };
    await page.goto(process.env.PWA_E2E_URL);
    await page.getByText('今月の支出 ¥0').waitFor();
    await page.locator('#settings-tab').click(); await click('ほかの端末と同期');
    const sync = page.locator('.device-link-dialog');
    await remainsOpen(sync);
    if (process.env.PWA_DIALOG_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.PWA_DIALOG_SCREENSHOT_DIR}/dialog-sync-${width}.png` });
    await outside(sync); await sync.waitFor({ state: 'detached' });
    if (process.env.PWA_DIALOG_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.PWA_DIALOG_SCREENSHOT_DIR}/dialog-sync-dismissed-${width}.png` });
    // Starting a connection and closing must also return to a fresh dialog on reopening.
    await click('ほかの端末と同期'); await click('この端末から始める');
    await outside(sync); await sync.waitFor({ state: 'detached' });
    await click('ほかの端末と同期'); await sync.getByRole('button', { name: 'この端末から始める', exact: true }).waitFor();
    await outside(sync);
    await click('記録を追加');
    const chooser = page.locator('#record-sheet'); await chooser.waitFor();
    await remainsOpen(chooser); await outside(chooser); await chooser.waitFor({ state: 'hidden' });
    await click('記録を追加'); await click('支出を手入力');
    await page.locator('#manual-transaction-payee').fill('Synthetic preserved draft');
    await page.locator('#manual-transaction-amount').fill('1200');
    await click('すべてのカテゴリから選ぶ');
    const category = page.locator('.category-sheet[open]'); await category.waitFor();
    await remainsOpen(category);
    await category.getByRole('button', { name: 'カテゴリを追加', exact: true }).click();
    const master = page.locator('.master-create-dialog'); await master.waitFor();
    await master.getByLabel('カテゴリ名', { exact: true }).fill('Synthetic unsaved category');
    await remainsOpen(master); await outside(master); await master.waitFor({ state: 'detached' });
    assert.equal(await category.evaluate(node => node.open), true);
    await outside(category); await category.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#manual-transaction-payee').inputValue(), 'Synthetic preserved draft');
    assert.equal(await page.locator('#manual-transaction-amount').inputValue(), '1200');
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('PASS: backdrop taps dismiss sync, chooser, category and master dialogs at phone/desktop widths; padding and drags stay open; parent drafts survive.');
} finally { await browser.close(); }
