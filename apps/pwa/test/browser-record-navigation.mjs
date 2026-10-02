import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-01T03:00:00Z'));
const errors = []; page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();
async function account(name) {
  await page.locator('#settings-tab').click(); await click('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: `${name} · 利用中`, exact: true }).waitFor();
}
async function category(name, income = false) {
  await page.locator('#settings-tab').click(); await click('カテゴリ'); if (income) await click('収入カテゴリ'); await click('カテゴリを追加する');
  await page.getByLabel('カテゴリ名', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).waitFor();
}
async function openChooser() { await page.locator('#home-tab').click(); await click('記録を追加'); }
async function save() { await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor(); }
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await account('Synthetic Navigation Wallet'); await category('Synthetic Navigation Food'); await category('Synthetic Navigation Income', true);

  await openChooser();
  await page.getByRole('heading', { name: '何を記録しますか？' }).waitFor();
  assert.deepEqual(await page.locator('#local-view button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label') ?? button.textContent)),
    ['閉じる', 'レシートを撮る', '保存した写真から', '支出を手入力', '収入', '口座間振替']);
  assert.equal(await page.locator('#local-view input[type=file]').count(), 2);
  if (process.env.PWA_RECORD_NAVIGATION_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RECORD_NAVIGATION_SCREENSHOT_PATH, fullPage: true });
  await click('支出を手入力');
  await page.locator('#manual-transaction-payee').waitFor();
  assert.equal(await page.getByRole('button', { name: 'キャンセル', exact: true }).count(), 1);
  await click('キャンセル');
  await page.getByRole('heading', { name: '何を記録しますか？' }).waitFor();
  await click('収入'); await page.locator('#manual-transaction-payee').waitFor(); await click('キャンセル');
  await page.getByRole('heading', { name: '何を記録しますか？' }).waitFor();
  await click('口座間振替'); await page.getByLabel('振替先口座', { exact: true }).waitFor(); await click('キャンセル');
  await page.getByRole('heading', { name: '何を記録しますか？' }).waitFor();
  // Closing returns to the screen the chooser was opened from (here, home).
  await click('閉じる');
  await page.locator('#home-tab[aria-current="page"]').waitFor();
  await page.locator('#receipt-tab').click();

  await click('口座・残高を見る');
  await page.getByRole('heading', { name: '支払元・口座残高' }).waitFor();
  await page.getByRole('button', { name: 'Synthetic Navigation Wallet · 利用中', exact: true }).waitFor();
  await page.locator('#settings-tab').click(); await click('支払元');
  await page.getByRole('heading', { name: '支払元・口座残高' }).waitFor();
  await page.locator('#receipt-tab').click(); await openChooser(); await click('収入');
  await page.locator('#manual-transaction-payee').fill('Synthetic Employer');
  await page.locator('#manual-transaction-amount').fill('1000');
  await page.locator('#manual-transaction-date').fill('2026-10-01');
  await page.locator('#manual-transaction-category').selectOption({ label: 'Synthetic Navigation Income' });
  await page.locator('#manual-transaction-account').selectOption({ label: 'Synthetic Navigation Wallet' });
  await save();
  await page.locator('#receipt-tab').click(); await page.getByRole('button', { name: /Synthetic Employer ·/ }).click();
  await click('編集する'); await click('キャンセル');
  await page.getByRole('heading', { name: '収入の記録' }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log('PASS: nested expense chooser, new-entry return targets, edit detail return, records-to-account-balances link, settings account management, and 375px horizontal overflow check');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; } finally { await browser.close(); }
