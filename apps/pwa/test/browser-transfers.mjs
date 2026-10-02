import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
async function openTransfer() {
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('口座間振替');
  await page.getByLabel('振替先口座', { exact: true }).waitFor();
}
async function fill(amount, source, destination, memo) {
  await page.getByLabel('金額（円）', { exact: true }).fill(String(amount));
  await page.getByLabel('日付', { exact: true }).fill('2026-10-01');
  await page.getByLabel('振替元口座', { exact: true }).selectOption({ label: source });
  await page.getByLabel('振替先口座', { exact: true }).selectOption({ label: destination });
  for (const summary of await page.locator('details.optional-fields:not([open]) > summary').all()) await summary.click(); await page.getByLabel('メモ（任意）', { exact: true }).fill(memo);
}
async function save(edit = false) {
  await click(edit ? '変更を保存する' : '登録する');
  await page.getByText(edit ? '変更を保存しました。' : '登録しました。', { exact: true }).waitFor();
}
async function edit() {
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: / · 振替 · / }).click();
  await page.getByRole('heading', { name: '振替の記録' }).waitFor(); await click('編集する');
  await page.getByLabel('振替先口座', { exact: true }).waitFor();
}
async function balance(name, amount) {
  await page.locator('#settings-tab').click(); await click('支払元');
  await page.getByRole('button', { name: `${name} · 利用中`, exact: true }).click();
  await page.getByText(`残高：${amount}`, { exact: false }).waitFor();
}
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await account('Synthetic Bank'); await account('Synthetic Wallet'); await account('Synthetic Other');
  await openTransfer();
  assert.equal(await page.locator('#manual-transaction-category').count(), 0);
  assert.equal(await page.locator('#manual-transaction-payee').count(), 0);
  await fill(10000, 'Synthetic Bank', 'Synthetic Bank', 'Synthetic transfer');
  await click('登録する'); await page.getByText('異なる口座を選んでください。', { exact: true }).waitFor();
  await fill(10000, 'Synthetic Bank', 'Synthetic Wallet', 'Synthetic transfer');
  await page.getByText('入力内容を端末に保存しました。', { exact: true }).waitFor();
  await click('キャンセル'); await openTransfer();
  assert.equal(await page.getByLabel('振替先口座', { exact: true }).inputValue(), await page.getByLabel('振替先口座', { exact: true }).locator('option').filter({ hasText: 'Synthetic Wallet' }).getAttribute('value'));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.PWA_TRANSFER_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_TRANSFER_SCREENSHOT_PATH, fullPage: true });
  await save();
  assert.equal(await page.getByRole('button', { name: / · 振替 · / }).count(), 1);
  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥0').waitFor();
  await edit(); await fill(12000, 'Synthetic Other', 'Synthetic Bank', 'Synthetic edited transfer'); await save(true);
  await page.reload(); await page.getByText('今月の支出 ¥0').waitFor();
  await edit();
  assert.equal(await page.getByLabel('金額（円）', { exact: true }).inputValue(), '12000');
  assert.equal(await page.getByLabel('振替元口座', { exact: true }).locator('option:checked').textContent(), 'Synthetic Other');
  assert.equal(await page.getByLabel('振替先口座', { exact: true }).locator('option:checked').textContent(), 'Synthetic Bank');
  await click('キャンセル');
  await page.locator('#settings-tab').click(); const downloadPromise = page.waitForEvent('download'); await page.locator('#backup-export').click();
  const download = await downloadPromise; const buffer = await readFile(await download.path());
  const navigation = page.waitForNavigation({ waitUntil: 'load' }); page.once('dialog', dialog => dialog.accept());
  await page.locator('#backup-file').setInputFiles({ name: 'synthetic-transfer.kmb', mimeType: 'application/vnd.kakeimatch.backup', buffer });
  await navigation; await page.getByText('今月の支出 ¥0').waitFor(); await edit();
  assert.equal(await page.getByLabel('金額（円）', { exact: true }).inputValue(), '12000');
  await click('キャンセル');
  await balance('Synthetic Other', '−¥12,000');
  await balance('Synthetic Bank', '+¥12,000');
  await balance('Synthetic Wallet', '¥0');
  await edit();
  await context.setOffline(true);
  await fill(13000, 'Synthetic Other', 'Synthetic Bank', 'Synthetic offline transfer'); await save(true);
  await click('記録一覧へ戻る');
  await page.getByRole('button', { name: /^Synthetic Bank · .*振替 · .*¥13,000$/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: / · 振替 · / }).count(), 1);
  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥0').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: native transfer create/edit, distinct accounts, one list row, excluded spending, draft/reload/backup/offline');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; } finally { await browser.close(); }
