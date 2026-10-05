import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage(); await page.clock.setFixedTime(new Date('2026-10-01T03:00:00Z'));
const errors = []; page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();
const dialog = () => page.getByRole('dialog');
const shortcut = field => page.locator(`[data-master-shortcut-for="${field}"]`).click();
async function create(field, name, category = false) {
  const trigger = page.locator(`[data-master-shortcut-for="${field}"]`);
  await trigger.click(); await dialog().waitFor();
  await dialog().getByLabel(category ? 'カテゴリ名' : '支払元の名前', { exact: true }).fill(name);
  await dialog().getByRole('button', { name: '追加する', exact: true }).click();
  await dialog().waitFor({ state: 'detached' });
  assert.equal(await page.locator(`#${field} option:checked`).textContent(), name);
  assert.equal(await trigger.evaluate(node => document.activeElement === node), true);
}
async function chooser(kind) { await page.locator('#home-tab').click(); await click('記録を追加'); await click(kind === '支出' ? '支出を手入力' : kind); await page.locator('#manual-transaction-amount').waitFor(); }
async function fill(name, amount) {
  await page.locator('#manual-transaction-payee').fill(name); await page.locator('#manual-transaction-amount').fill(amount);
  await page.locator('#manual-transaction-date').fill('2026-09-28'); for (const summary of await page.locator('details.optional-fields:not([open]) > summary').all()) await summary.click(); await page.locator('#manual-transaction-memo').fill('Synthetic preserved memo');
}
async function assertDraft(name, amount) {
  assert.equal(await page.locator('#manual-transaction-payee').inputValue(), name);
  assert.equal(await page.locator('#manual-transaction-amount').inputValue(), amount);
  assert.equal(await page.locator('#manual-transaction-date').inputValue(), '2026-09-28');
  assert.equal(await page.locator('#manual-transaction-memo').inputValue(), 'Synthetic preserved memo');
}
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await chooser('支出'); await fill('Synthetic entry expense', '900');
  await shortcut('manual-transaction-category');
  await dialog().getByRole('heading', { name: '支出カテゴリを追加' }).waitFor();
  if (process.env.PWA_ENTRY_MASTERS_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_ENTRY_MASTERS_SCREENSHOT_PATH });
  await dialog().getByLabel('カテゴリ名', { exact: true }).fill('   '); await dialog().getByRole('button', { name: '追加する', exact: true }).click();
  await dialog().getByText('カテゴリ名を入力してください。', { exact: true }).waitFor();
  await dialog().getByLabel('カテゴリ名', { exact: true }).fill('Synthetic Entry Food'); await dialog().getByRole('button', { name: '追加する', exact: true }).click(); await dialog().waitFor({ state: 'detached' });
  assert.equal(await page.locator('#manual-transaction-category option:checked').textContent(), 'Synthetic Entry Food');
  await assertDraft('Synthetic entry expense', '900');
  const categoryShortcut = page.locator('[data-master-shortcut-for="manual-transaction-category"]');
  const categoryId = await page.locator('#manual-transaction-category').inputValue();
  await categoryShortcut.click(); await dialog().getByRole('button', { name: '入力へ戻る', exact: true }).click(); await dialog().waitFor({ state: 'detached' });
  assert.equal(await page.locator('#manual-transaction-category').inputValue(), categoryId);
  assert.equal(await categoryShortcut.evaluate(node => document.activeElement === node), true);
  await assertDraft('Synthetic entry expense', '900');
  await create('manual-transaction-account', 'Synthetic Entry Wallet'); await assertDraft('Synthetic entry expense', '900');
  const walletId = await page.locator('#manual-transaction-account').inputValue();
  await shortcut('manual-transaction-account'); await dialog().getByLabel('支払元の名前', { exact: true }).fill('Synthetic Cancelled'); await dialog().getByRole('button', { name: '入力へ戻る', exact: true }).click();
  assert.equal(await page.locator('#manual-transaction-account').inputValue(), walletId); await assertDraft('Synthetic entry expense', '900');
  await click('キャンセル'); await click('支出を手入力'); await assertDraft('Synthetic entry expense', '900');
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();

  await chooser('収入'); await fill('Synthetic entry income', '250000');
  await create('manual-transaction-category', 'Synthetic Entry Salary', true);
  assert.equal(await page.locator('#manual-transaction-category option').filter({ hasText: 'Synthetic Entry Food' }).count(), 0);
  await create('manual-transaction-account', 'Synthetic Entry Bank'); await assertDraft('Synthetic entry income', '250000');
  await shortcut('manual-transaction-category');
  const other = await context.newPage(); await other.goto(process.env.PWA_E2E_URL); await other.getByRole('button', { name: '記録を追加', exact: true }).click(); await other.getByRole('button', { name: '収入', exact: true }).click();
  await other.getByText('別の画面でこの記録を編集中です。閉じてから開き直してください。', { exact: true }).waitFor(); await other.close();
  await dialog().getByRole('button', { name: '入力へ戻る', exact: true }).click();
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();

  await chooser('口座間振替'); await page.locator('#manual-transaction-amount').fill('1500'); for (const summary of await page.locator('details.optional-fields:not([open]) > summary').all()) await summary.click(); await page.locator('#manual-transaction-memo').fill('Synthetic transfer memo');
  await create('manual-transaction-account', 'Synthetic New Source'); const source = await page.locator('#manual-transaction-account').inputValue();
  await create('manual-transaction-destination', 'Synthetic New Destination'); assert.equal(await page.locator('#manual-transaction-account').inputValue(), source);
  assert.equal(await page.locator('#manual-transaction-amount').inputValue(), '1500'); assert.equal(await page.locator('#manual-transaction-memo').inputValue(), 'Synthetic transfer memo');
  await click('キャンセル');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64') });
  await page.locator('#receipt-merchant').fill('Synthetic Entry Receipt'); await page.locator('#receipt-amount').fill('900'); await page.locator('#receipt-date').fill('2026-09-27'); for (const summary of await page.locator('details.optional-fields:not([open]) > summary').all()) await summary.click(); await page.locator('#receipt-time').fill('13:15');
  await create('receipt-category', 'Synthetic Receipt Food', true); await create('receipt-account', 'Synthetic Receipt Wallet');
  assert.equal(await page.locator('#receipt-merchant').inputValue(), 'Synthetic Entry Receipt'); assert.equal(await page.locator('#receipt-date').inputValue(), '2026-09-27'); assert.equal(await page.locator('#receipt-time').inputValue(), '13:15');
  for (const [name, amount] of [['Synthetic Apple', '400'], ['Synthetic Soap', '500']]) {
    const count = await page.locator('[data-receipt-item]').count();
    await page.locator('#receipt-merchant').focus(); await click('品目を追加');
    await page.waitForFunction(expected => document.querySelectorAll('[data-receipt-item]').length === expected, count + 1);
    const item = page.locator('[data-receipt-item]').last(); if (await item.getAttribute('open') === null) await item.locator('summary').click(); await item.locator('[data-item-name]').fill(name); await item.locator('[data-item-amount]').fill(amount);
  }
  const firstItem = page.locator('[data-receipt-item]').first(); if (await firstItem.getAttribute('open') === null) await firstItem.locator('summary').click();
  const itemField = await firstItem.locator('[data-item-category]').getAttribute('id');
  await create(itemField, 'Synthetic Item Category', true);
  assert.equal(await firstItem.locator('[data-item-name]').inputValue(), 'Synthetic Apple'); assert.equal(await firstItem.locator('[data-item-amount]').inputValue(), '400'); assert.equal(await firstItem.getAttribute('open'), '');
  assert.equal(await page.locator('[data-receipt-item]').count(), 2); assert.equal(await page.locator('#receipt-amount').inputValue(), '900');
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
  await page.locator('#receipt-tab').click(); await page.getByRole('button', { name: /^Synthetic Entry Receipt ·/ }).click(); await click('編集する');
  await page.locator('#receipt-merchant').fill('Synthetic Receipt Edited');
  await create('receipt-category', 'Synthetic Edit Category', true); await create('receipt-account', 'Synthetic Edit Wallet');
  assert.equal(await page.locator('#receipt-merchant').inputValue(), 'Synthetic Receipt Edited'); assert.equal(await page.locator('[data-receipt-item]').count(), 2);
  await click('変更を保存する'); await page.getByText('変更を保存しました。', { exact: true }).waitFor();
  await page.locator('#settings-tab').click(); await click('カテゴリ'); await page.getByRole('button', { name: /^Synthetic Edit Category ·/ }).waitFor();
  await page.locator('#settings-tab').click(); await click('支払元'); await page.getByRole('button', { name: 'Synthetic Edit Wallet · 利用中', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepEqual(errors, []);
  console.log('PASS: expense/income/receipt/edit/item/transfer master shortcuts, preserved input, source selection, refresh, cancellation, validation and editor lock at 375px');
} catch (error) { console.log(await page.locator('body').innerText()); console.log(errors); throw error; } finally { await browser.close(); }
