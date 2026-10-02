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
async function addAccount(name) {
  await page.locator('#settings-tab').click(); await click('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: `${name} · 利用中`, exact: true }).waitFor();
}
async function addCategory(name, income = false) {
  await page.locator('#settings-tab').click(); await click('カテゴリ'); if (income) await click('収入カテゴリ');
  await click('カテゴリを追加する'); await page.getByLabel('カテゴリ名', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).waitFor();
}
async function manual(kind, store, amount, category, account, date = '2026-10-01') {
  await page.locator('#home-tab').click(); await click('記録を追加'); await click(kind === '支出' ? '支出を手入力' : kind);
  await page.locator('#manual-transaction-payee').fill(store);
  await page.locator('#manual-transaction-amount').fill(String(amount));
  await page.locator('#manual-transaction-date').fill(date);
  await page.locator('#manual-transaction-category').selectOption({ label: category });
  await page.locator('#manual-transaction-account').selectOption({ label: account });
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
async function transfer(amount, source, destination) {
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('口座間振替');
  await page.getByLabel('金額（円）', { exact: true }).fill(String(amount));
  await page.getByLabel('日付', { exact: true }).fill('2026-10-01');
  await page.getByLabel('振替元口座', { exact: true }).selectOption({ label: source });
  await page.getByLabel('振替先口座', { exact: true }).selectOption({ label: destination });
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
async function accounts() { await page.locator('#settings-tab').click(); await click('支払元'); }
async function balance(name, expected) {
  await accounts();
  const row = page.getByRole('button', { name: new RegExp(`^${name} ·`) });
  await row.waitFor();
  assert.equal((await row.locator('.account-balance').innerText()).trim(), expected);
}
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await addAccount('Synthetic Cash'); await addAccount('Synthetic Bank'); await addAccount('Synthetic Closed Zero');
  await addCategory('Synthetic Balance Food'); await addCategory('Synthetic Balance Salary', true);
  await manual('支出', 'Synthetic Balance Shop', 1500, 'Synthetic Balance Food', 'Synthetic Cash');
  await balance('Synthetic Cash', '−¥1,500');
  await manual('収入', 'Synthetic Balance Employer', 200000, 'Synthetic Balance Salary', 'Synthetic Bank');
  await transfer(8000, 'Synthetic Bank', 'Synthetic Cash');
  await manual('支出', 'Synthetic Future Shop', 9000, 'Synthetic Balance Food', 'Synthetic Cash', '2026-11-01');

  await balance('Synthetic Cash', '¥6,500');
  await balance('Synthetic Bank', '¥192,000');
  // The two transfer sides contribute equal and opposite balance changes.
  await page.getByRole('button', { name: 'Synthetic Cash · 利用中', exact: true }).click();
  await page.locator('[data-detail="残高"] dd').getByText('+¥6,500', { exact: true }).waitFor(); await click('口座の記録を見る');
  await page.getByRole('heading', { name: 'Synthetic Cashの記録', exact: true }).waitFor();
  await page.getByRole('button', { name: /· 10\/1 · 振替 · .*¥8,000$/ }).click();
  await page.getByRole('heading', { name: '振替の記録', exact: true }).waitFor();
  await page.getByText('振替元口座', { exact: true }).waitFor();
  const detail = page.locator('#local-view dl.transaction-detail');
  assert.match(await detail.innerText(), /振替元口座\s+Synthetic Bank/);
  assert.match(await detail.innerText(), /振替先口座\s+Synthetic Cash/);
  await click('記録一覧へ戻る');

  await accounts(); await page.getByRole('button', { name: 'Synthetic Closed Zero · 利用中', exact: true }).click();
  await click('利用終了'); await page.locator('[data-detail="状態"] dd').getByText('利用終了', { exact: true }).waitFor();
  await accounts(); await page.locator('.closed-accounts summary').click();
  await page.getByRole('button', { name: 'Synthetic Closed Zero · 利用終了', exact: true }).waitFor();
  assert.ok(await page.locator('.closed-accounts').count());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.PWA_BALANCE_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_BALANCE_SCREENSHOT_PATH, fullPage: true });
  await page.reload(); await page.getByText('今月の支出 ¥1,500', { exact: false }).waitFor();
  await balance('Synthetic Cash', '¥6,500'); await balance('Synthetic Bank', '¥192,000');
  await context.setOffline(true);
  await balance('Synthetic Cash', '¥6,500'); await balance('Synthetic Bank', '¥192,000');
  assert.deepEqual(errors, []);
  console.log('PASS: current account balances include native transfer pairs, exclude future activity, and link account history to transfer detail offline/reload');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; } finally { await browser.close(); }
