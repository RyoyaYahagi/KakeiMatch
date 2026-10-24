import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();
const optionNames = select => select.locator('option').allTextContents();
async function newExpense() {
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('支出を手入力');
  await page.locator('#manual-transaction-payee').waitFor();
}
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await page.locator('#settings-tab').click(); await click('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Wallet'); await click('追加する');
  await page.getByRole('button', { name: 'Synthetic Wallet · 利用中', exact: true }).waitFor();
  for (let index = 0; index < 2; index++) {
    await newExpense();
    await page.locator('#manual-transaction-payee').fill(`Synthetic daily ${index}`);
    await page.locator('#manual-transaction-amount').fill('100');
    await page.locator('#manual-transaction-category').selectOption({ label: '日用品' });
    await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
  }
  await newExpense();
  const category = page.locator('#manual-transaction-category');
  assert.deepEqual((await optionNames(category)).slice(0, 3), ['選択してください', '日用品', '食費']);
  assert.equal(await category.locator('option:checked').textContent(), '日用品');
  await page.getByRole('button', { name: 'すべてのカテゴリから選ぶ', exact: true }).click();
  assert.equal(await page.getByRole('dialog').getByRole('radio').first().textContent(), '日用品');
  if (process.env.PWA_CATEGORY_ORDER_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_CATEGORY_ORDER_SCREENSHOT_PATH, animations: 'disabled' });
  await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click();
  await click('品目一覧'); await click('品目を追加');
  assert.deepEqual((await optionNames(page.locator('[data-item-category]').first())).slice(0, 3), ['未選択', '日用品', '食費']);
  await page.locator('#settings-tab').click(); await click('定期登録'); await click('定期登録を追加する');
  const recurringCategory = page.locator('select').filter({ has: page.locator('option', { hasText: '日用品' }) });
  await recurringCategory.waitFor();
  assert.deepEqual((await optionNames(recurringCategory)).slice(0, 3), ['選択してください', '日用品', '食費']);
  assert.deepEqual(errors, []);
  console.log('Category frequency order passed: entry sheet, item dropdown, recurring dropdown, and last-used value.');
} finally { await browser.close(); }
