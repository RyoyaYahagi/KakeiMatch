import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { waitForBackupExportReady } from './backup-e2e-helpers.mjs';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-01T03:00:00Z'));
const errors = []; page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();
const item = index => page.locator('[data-receipt-item]').nth(index);
async function waitForOpenItem(index) {
  await page.waitForFunction(expected => [...document.querySelectorAll('[data-receipt-item]')]
    .every((row, i) => row.open === (i === expected)), index);
}
async function save(edit = false) {
  await click(edit ? '変更を保存する' : '登録する');
  await page.getByText(edit ? '変更を保存しました。' : '登録しました。', { exact: true }).waitFor();
}
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await page.locator('#settings-tab').click(); await click('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Wallet'); await click('追加する');
  await page.getByRole('button', { name: 'Synthetic Wallet · 利用中', exact: true }).waitFor();
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('支出を手入力');
  await page.locator('#manual-transaction-payee').waitFor();
  assert.equal(await page.locator('.purchase-details > summary').textContent(), '品目分けない（品目・値引き・税額）');
  assert.equal(await page.getByRole('button', { name: '全体', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('button', { name: '品目一覧', exact: true }).count(), 1);
  await page.locator('#manual-transaction-payee').fill('Synthetic Manual Items');
  await page.locator('#manual-transaction-amount').fill('1400');
  await page.locator('#manual-transaction-category').selectOption({ label: '食費' });
  for (const summary of await page.locator('details.optional-fields:not([open]) > summary').all()) await summary.click(); for (const summary of await page.locator('details.optional-fields:not([open]) > summary').all()) await summary.click(); await page.locator('#manual-transaction-memo').fill('Synthetic memo');
  await click('品目一覧');
  assert.equal(await page.locator('#manual-transaction-payee').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: '品目を追加', exact: true }).isVisible(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  for (const [name, amount, category] of [['Synthetic Apple', '1000', '食費'], ['Synthetic Soap', '500', '日用品'], ['Temporary', '20', '食費']]) {
    await click('品目を追加'); const row = page.locator('[data-receipt-item]').last();
    await row.locator('[data-item-name]').fill(name); await row.locator('[data-item-amount]').fill(amount);
    await row.locator('[data-item-category]').selectOption({ label: category });
  }
  await waitForOpenItem(2);
  assert.equal(await page.getByRole('button', { name: '品目一覧', exact: true }).count(), 1);
  assert.equal(await item(0).getAttribute('open'), null);
  assert.equal(await item(1).getAttribute('open'), null);
  assert.equal(await item(2).getAttribute('open'), '');
  const collapsedHeight = (await item(0).locator('summary').boundingBox()).height;
  assert.ok(collapsedHeight <= 52, `collapsed item row should stay compact, got ${collapsedHeight}px`);
  await item(0).locator('summary').click();
  await waitForOpenItem(0);
  assert.equal(await item(0).getAttribute('open'), '');
  assert.equal(await item(2).getAttribute('open'), null);
  await item(2).locator('summary').click();
  await waitForOpenItem(2);
  await click('値引きを追加');
  const discount = page.locator('[data-receipt-adjustment]').first();
  await discount.locator('[data-adjustment-label]').fill('Synthetic Coupon');
  await discount.locator('[data-adjustment-amount]').fill('100');
  await discount.locator('[data-adjustment-target]').selectOption(await item(0).getAttribute('data-receipt-item'));
  if (await item(2).getAttribute('open') === null) await item(2).locator('summary').click();
  const remove = item(2).getByRole('button', { name: '品目を削除', exact: true });
  assert.ok((await remove.boundingBox()).height >= 44);
  // The full view hides item details; returning to the item pane keeps the opened item and entries.
  await click('全体');
  assert.equal(await page.locator('#manual-transaction-payee').isVisible(), true);
  assert.equal(await item(2).isVisible(), false);
  await click('品目一覧');
  assert.equal(await item(2).getAttribute('open'), '');
  // Blur must not close the editor before a touch on the delete button.
  await item(2).locator('[data-item-name]').focus(); await discount.locator('[data-adjustment-label]').focus();
  assert.equal(await remove.isVisible(), true);
  if (process.env.PWA_ITEM_DELETE_SCREENSHOT_PATH) { await remove.scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.PWA_ITEM_DELETE_SCREENSHOT_PATH }); }
  await remove.click(); assert.equal(await page.locator('[data-receipt-item]').count(), 2);
  await click('全体');
  assert.equal(await page.locator('#manual-transaction-amount').inputValue(), '1400');
  // A missing basic field must be revealed when registering from the item pane.
  // Keep the items and memo intact throughout failed validation.
  // The category is not asked for while every item has one (docs/UX.md 支出の入力), so it is checked separately below.
  for (const fieldName of ['payee', 'amount', 'date', 'account']) {
    const field = page.locator(`#manual-transaction-${fieldName}`);
    const original = await field.inputValue();
    if (fieldName === 'account' || fieldName === 'category') await field.selectOption('');
    else await field.fill('');
    await click('品目一覧');
    if (fieldName === 'payee' && process.env.PWA_INVALID_ENTRY_BEFORE_PATH) await page.screenshot({ path: process.env.PWA_INVALID_ENTRY_BEFORE_PATH });
    await click('登録する');
    await page.waitForFunction(() => !document.querySelector('.entry-overview-fields').hidden, null, { timeout: 5000 });
    if (fieldName === 'payee' && process.env.PWA_INVALID_ENTRY_AFTER_PATH) await page.screenshot({ path: process.env.PWA_INVALID_ENTRY_AFTER_PATH });
    assert.equal(await page.getByRole('button', { name: '全体', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#manual-transaction-memo').inputValue(), 'Synthetic memo');
    assert.equal(await item(0).locator('[data-item-name]').inputValue(), 'Synthetic Apple');
    assert.equal(await page.locator('[data-receipt-item]').count(), 2);
    assert.equal(await page.locator('#message').textContent() === '登録しました。', false);
    if (fieldName === 'account' || fieldName === 'category') await field.selectOption(original);
    else await field.fill(original);
  }
  if (process.env.PWA_MANUAL_ITEMS_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_MANUAL_ITEMS_SCREENSHOT_PATH, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // With items, the row shows the split, and the record takes its category from the items.
  await page.locator('#manual-transaction-category').selectOption('');
  assert.match(await page.locator('.derived-category').getAttribute('aria-label'), /^カテゴリは品目ごと：食費 ¥1,000、日用品 ¥500/);
  await save();
  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥1,400', { exact: false }).waitFor();
  await page.getByText('すべてのカテゴリ', { exact: true }).click();
  await page.locator('.category-list').getByText(/^食費 · ¥900 ·/).waitFor();
  await page.locator('.category-list').getByText(/^日用品 · ¥500 ·/).waitFor();
  await page.locator('#receipt-tab').click(); await page.getByRole('button', { name: /^Synthetic Manual Items ·/ }).click();
  await click('編集する'); await click('品目一覧'); await item(0).locator('summary').click();
  assert.equal(await page.locator('#manual-transaction-memo').inputValue(), 'Synthetic memo');
  assert.equal(await page.locator('[data-adjustment-amount]').inputValue(), '100');
  await item(0).getByRole('button', { name: '品目を削除', exact: true }).click();
  assert.equal(await page.locator('[data-adjustment-target]').inputValue(), '');
  assert.equal(await item(0).locator('[data-item-name]').inputValue(), 'Synthetic Soap');
  assert.equal(await page.locator('#manual-transaction-amount').inputValue(), '1400');
  await save(true);
  await page.locator('#settings-tab').click(); const downloadPromise = page.waitForEvent('download'); await page.locator('#backup-export').click();
  const download = await downloadPromise; const file = await download.path(); assert.ok(file); const buffer = await readFile(file);
  await waitForBackupExportReady(page);
  const navigation = page.waitForNavigation({ waitUntil: 'load' }); page.once('dialog', dialog => dialog.accept());
  await page.locator('#backup-file').setInputFiles({ name: 'synthetic-manual-items.kmb', mimeType: 'application/vnd.kakeimatch.backup', buffer });
  await navigation; await page.getByText('今月の支出 ¥1,400', { exact: false }).waitFor();
  await page.locator('#receipt-tab').click(); await page.getByRole('button', { name: /^Synthetic Manual Items ·/ }).click(); await click('編集する');
  assert.equal(await page.locator('[data-adjustment-amount]').inputValue(), '100');
  assert.equal(await page.locator('#manual-transaction-memo').inputValue(), 'Synthetic memo');
  assert.equal(await page.locator('[data-receipt-item]').count(), 1);
  await context.setOffline(true); await click('品目一覧'); await item(0).locator('summary').click(); await item(0).locator('[data-item-name]').fill('Synthetic Offline Soap'); await save(true);
  assert.deepEqual(errors, []);
  console.log('PASS: manual items, positive discount, stable split/edit, touch deletion, backup compatibility, offline and 375px');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; } finally { await browser.close(); }
