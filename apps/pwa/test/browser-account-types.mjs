import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { waitForBackupExportReady } from './backup-e2e-helpers.mjs';
if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, acceptDownloads: true });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();
async function accounts() { await page.locator('#settings-tab').click(); await click('支払元'); }
async function add(name, type) {
  await accounts(); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill(name);
  if (type) await page.getByLabel('種類', { exact: true }).selectOption(type);
  await click('追加する'); await page.getByRole('button', { name: `${name} · 利用中`, exact: true }).waitFor();
}
async function detail(name) { await accounts(); await click(`${name} · 利用中`); }
async function groups(field) { return page.locator(`${field} optgroup`).evaluateAll(nodes => nodes.map(node => node.label)); }
async function noOverflow() { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await add('Synthetic Legacy Bank'); // No inference from names.
  await detail('Synthetic Legacy Bank'); await page.locator('[data-detail="種類"] dd').getByText('その他 / 未分類', { exact: true }).waitFor();
  await click('編集する'); await page.getByLabel('種類', { exact: true }).selectOption('bank'); await click('変更を保存');
  await page.locator('[data-detail="種類"] dd').getByText('銀行口座', { exact: true }).waitFor();
  await add('Synthetic Card', 'credit_card'); await add('Synthetic Wallet', 'cash'); await add('Synthetic Other', 'other');
  await accounts();
  await page.locator('[data-account-type="bank"]').getByRole('button', { name: 'Synthetic Legacy Bank · 利用中', exact: true }).waitFor();
  await page.locator('[data-account-type="credit_card"]').getByText('差引預り額 ¥0', { exact: true }).waitFor();
  await noOverflow();
  if (process.env.PWA_ACCOUNT_TYPES_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_ACCOUNT_TYPES_SCREENSHOT_PATH, fullPage: true });
  await detail('Synthetic Card'); await click('利用終了'); await page.locator('[data-detail="状態"] dd').getByText('利用終了', { exact: true }).waitFor();
  await page.locator('[data-detail="種類"] dd').getByText('クレジットカード', { exact: true }).waitFor();
  await click('利用を再開する'); await page.locator('[data-detail="状態"] dd').getByText('利用中', { exact: true }).waitFor();
  await click('編集する');
  await page.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Renamed Card'); await click('変更を保存');
  await page.locator('[data-detail="種類"] dd').getByText('クレジットカード', { exact: true }).waitFor();
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('支出を手入力');
  const expenseField = '#manual-transaction-account';
  await page.locator(expenseField).waitFor();
  assert.deepEqual(await groups(expenseField), ['クレジットカード', '銀行口座', '現金', 'その他 / 未分類']);
  await page.locator('#manual-transaction-payee').fill('Synthetic Draft');
  await page.locator('[data-master-shortcut-for="manual-transaction-account"]').click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Inline Bank');
  await dialog.getByLabel('種類', { exact: true }).selectOption('bank'); await dialog.getByRole('button', { name: '追加する', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.locator(`${expenseField} option:checked`).textContent(), 'Synthetic Inline Bank');
  assert.equal(await page.locator('#manual-transaction-payee').inputValue(), 'Synthetic Draft');
  assert.equal(await page.locator(`${expenseField} optgroup[label="銀行口座"] option`).filter({ hasText: 'Synthetic Inline Bank' }).count(), 1);
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('収入');
  await page.locator(expenseField).waitFor();
  assert.deepEqual(await groups(expenseField), ['銀行口座', '現金', 'その他 / 未分類', 'クレジットカード']);
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('口座間振替');
  await page.locator('#manual-transaction-destination').waitFor();
  assert.deepEqual(await groups('#manual-transaction-destination'), ['銀行口座', '現金', 'その他 / 未分類', 'クレジットカード']);
  await noOverflow();
  await page.locator('#settings-tab').click(); const downloadPromise = page.waitForEvent('download'); await page.locator('#backup-export').click();
  const download = await downloadPromise; const buffer = await readFile(await download.path());
  await waitForBackupExportReady(page);
  page.once('dialog', dialog => dialog.accept()); const navigation = page.waitForNavigation({ waitUntil: 'load' });
  await page.locator('#backup-file').setInputFiles({ name: 'synthetic-account-types.kmb', mimeType: 'application/vnd.kakeimatch.backup', buffer });
  await navigation; await page.getByText('今月の支出 ¥0').waitFor();
  await detail('Synthetic Renamed Card'); await page.locator('[data-detail="種類"] dd').getByText('クレジットカード', { exact: true }).waitFor();
  await detail('Synthetic Legacy Bank'); await page.locator('[data-detail="種類"] dd').getByText('銀行口座', { exact: true }).waitFor();
  await detail('Synthetic Inline Bank'); await page.locator('[data-detail="種類"] dd').getByText('銀行口座', { exact: true }).waitFor();
  await page.reload(); await page.getByText('今月の支出 ¥0').waitFor(); await context.setOffline(true);
  await detail('Synthetic Wallet'); await page.locator('[data-detail="種類"] dd').getByText('現金', { exact: true }).waitFor();
  await noOverflow(); assert.deepEqual(errors, []);
  console.log('PASS: account type creation/edit/grouping, no name inference, lifecycle, in-entry creation, income/transfer ordering, backup/restore, reload/offline and 375px layout');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; } finally { await browser.close(); }
