import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic test preview.');
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
async function category(name, income) {
  await page.locator('#settings-tab').click(); await click('カテゴリ'); if (income) await click('収入カテゴリ');
  await click('カテゴリを追加する'); await page.getByLabel('カテゴリ名', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).waitFor();
}
async function chooser(kind) { await page.locator('#home-tab').click(); await click('記録を追加'); await click(kind === '支出' ? '支出を手入力' : kind); await page.locator('#manual-transaction-payee').waitFor(); }
async function fill(name, amount, categoryName, accountName, memo) {
  await page.locator('#manual-transaction-payee').fill(name);
  await page.locator('#manual-transaction-amount').fill(String(amount));
  await page.locator('#manual-transaction-date').fill('2026-10-01');
  await page.locator('#manual-transaction-category').selectOption({ label: categoryName });
  await page.locator('#manual-transaction-account').selectOption({ label: accountName });
  for (const summary of await page.locator('details.optional-fields:not([open]) > summary').all()) await summary.click(); for (const summary of await page.locator('details.optional-fields:not([open]) > summary').all()) await summary.click(); await page.locator('#manual-transaction-memo').fill(memo);
}
async function save(editing = false) { await click(editing ? '変更を保存する' : '登録する'); await page.getByText(editing ? '変更を保存しました。' : '登録しました。', { exact: true }).waitFor(); }
async function detail(name) { await page.locator('#receipt-tab').click(); await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).click(); await click('編集する'); await page.locator('#manual-transaction-payee').waitFor(); }
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  assert.deepEqual(await page.locator('nav .nav-button').allTextContents(), ['ホーム', '記録', '照合', '設定']);
  assert.equal(await page.locator('nav').getByRole('button', { name: '記録を追加', exact: true }).count(), 1);
  await account('Synthetic Wallet'); await account('Synthetic Bank');
  await category('Synthetic Food', false); await category('Synthetic Salary', true);
  await chooser('支出');
  assert.equal(await page.locator('#manual-transaction-category option').filter({ hasText: 'Synthetic Salary' }).count(), 0);
  assert.equal(await page.locator('[data-receipt-item]').count(), 0);
  await fill('Synthetic Shop', 1500, 'Synthetic Food', 'Synthetic Wallet', 'Synthetic expense memo');
  await save();
  await chooser('収入');
  assert.equal(await page.locator('#manual-transaction-category option').filter({ hasText: 'Synthetic Food' }).count(), 0);
  await fill('Synthetic Employer', 200000, 'Synthetic Salary', 'Synthetic Bank', 'Synthetic income memo');
  await page.getByText('入力内容を端末に保存しました。', { exact: true }).waitFor();
  const other = await context.newPage();
  await other.clock.setFixedTime(new Date('2026-10-01T03:00:00Z'));
  await other.goto(process.env.PWA_E2E_URL);
  await other.getByText('今月の支出 ¥1,500', { exact: false }).waitFor();
  await other.getByRole('button', { name: '記録を追加', exact: true }).click();
  await other.getByRole('button', { name: '収入', exact: true }).click();
  await other.getByText('別の画面でこの記録を編集中です。閉じてから開き直してください。', { exact: true }).waitFor();
  assert.equal(await other.locator('#manual-transaction-payee').count(), 0);
  await page.locator('#settings-tab').click();
  await other.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await other.getByRole('heading', { name: '何を記録しますか？' }).waitFor();
  await other.getByRole('button', { name: '収入', exact: true }).click();
  await other.locator('#manual-transaction-payee').waitFor();
  assert.equal(await other.locator('#manual-transaction-payee').inputValue(), 'Synthetic Employer');
  assert.equal(await other.locator('#manual-transaction-memo').inputValue(), 'Synthetic income memo');
  await other.close();
  await page.reload(); await page.getByText('今月の支出 ¥1,500', { exact: false }).waitFor();
  await chooser('収入');
  assert.equal(await page.locator('#manual-transaction-payee').inputValue(), 'Synthetic Employer');
  assert.equal(await page.locator('#manual-transaction-amount').inputValue(), '200000');
  assert.equal(await page.locator('#manual-transaction-memo').inputValue(), 'Synthetic income memo');
  if (process.env.PWA_MANUAL_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_MANUAL_SCREENSHOT_PATH, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await save();
  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥1,500', { exact: false }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#transactions li').length === 2);
  assert.equal(await page.locator('#transactions li').count(), 2);
  assert.match(await page.locator('#transactions').innerText(), /収入[\s\S]*\+¥200,000/);
  await detail('Synthetic Shop');
  assert.equal(await page.locator('#manual-transaction-memo').inputValue(), 'Synthetic expense memo');
  await fill('Synthetic Shop Edited', 2000, 'Synthetic Food', 'Synthetic Bank', 'Synthetic edited expense');
  await page.locator('#manual-transaction-date').fill('2026-10-02');
  await save(true);
  await detail('Synthetic Shop Edited');
  assert.equal(await page.locator('#manual-transaction-date').inputValue(), '2026-10-02');
  await page.locator('#manual-transaction-date').fill('2026-10-01');
  await save(true);
  await detail('Synthetic Employer');
  assert.equal(await page.locator('#manual-transaction-amount').inputValue(), '200000');
  await fill('Synthetic Employer Edited', 230000, 'Synthetic Salary', 'Synthetic Wallet', 'Synthetic edited income');
  await save(true);
  await page.reload(); await page.getByText('今月の支出 ¥2,000', { exact: false }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#transactions li').length === 2);
  assert.equal(await page.locator('#transactions li').count(), 2);
  await detail('Synthetic Employer Edited');
  assert.equal(await page.locator('#manual-transaction-account option:checked').textContent(), 'Synthetic Wallet');
  assert.equal(await page.locator('#manual-transaction-memo').inputValue(), 'Synthetic edited income');
  await click('キャンセル');
  await page.locator('#settings-tab').click(); const downloadPromise = page.waitForEvent('download'); await page.locator('#backup-export').click();
  const download = await downloadPromise; const path = await download.path(); assert.ok(path); const buffer = await readFile(path);
  // The download starts before the export finishes; a restore chosen meanwhile is ignored as a concurrent operation.
  await page.getByText('バックアップを生成しました。Filesなどへの保存を確認してください。', { exact: true }).waitFor();
  const navigation = page.waitForNavigation({ waitUntil: 'load' }); page.once('dialog', dialog => dialog.accept());
  await page.locator('#backup-file').setInputFiles({ name: 'synthetic-manual.kmb', mimeType: 'application/vnd.kakeimatch.backup', buffer });
  await navigation; await page.getByText('今月の支出 ¥2,000', { exact: false }).waitFor();
  await detail('Synthetic Shop Edited');
  assert.equal(await page.locator('#manual-transaction-amount').inputValue(), '2000');
  assert.equal(await page.locator('#manual-transaction-account option:checked').textContent(), 'Synthetic Bank');
  assert.equal(await page.locator('#manual-transaction-memo').inputValue(), 'Synthetic edited expense');
  await context.setOffline(true);
  await fill('Synthetic Offline Expense', 2100, 'Synthetic Food', 'Synthetic Bank', 'Synthetic offline edit'); await save(true);
  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥2,100', { exact: false }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: four-tab navigation, manual income/expense with separate categories, account/date/memo editing, reload, .kmb restore and offline write without cloud account');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; } finally { await browser.close(); }
