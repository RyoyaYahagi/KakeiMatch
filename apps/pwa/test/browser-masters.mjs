import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a synthetic-only local or preview PWA.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_no_cloud_account' } }));
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const click = name => page.getByRole('button', { name, exact: true }).click();
async function settings(kind) { await page.locator('#settings-tab').click(); await click(kind); }
async function addAccount(name) {
  await settings('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: `${name} · 利用中`, exact: true }).waitFor();
}
async function addCategory(name, income = false) {
  await settings('カテゴリ'); if (income) await click('収入カテゴリ');
  await click('カテゴリを追加する'); await page.getByLabel('カテゴリ名', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: new RegExp(`^${name} · 表示中`) }).waitFor();
}
async function categoryDetail(name) {
  await settings('カテゴリ'); await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).click();
  await page.getByText(`カテゴリ名：${name}`, { exact: true }).waitFor();
}
async function accountDetail(name, closed = false) {
  await settings('支払元'); await click(`${name} · ${closed ? '利用終了' : '利用中'}`);
  await page.getByText(`支払元：${name}`, { exact: true }).waitFor();
}
async function noOverflow() {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}
async function newReceipt() {
  await page.locator('#receipt-tab').click(); await click('＋記録'); await click('レシートから支出');
  await page.locator('#local-view input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64') });
  await page.locator('#receipt-merchant').waitFor();
}
async function fillReceipt(merchant, account, category) {
  await newReceipt();
  await page.locator('#receipt-merchant').fill(merchant);
  await page.locator('#receipt-date').fill('2026-10-01');
  await page.locator('#receipt-amount').fill('1200');
  await page.locator('#receipt-account').selectOption({ label: account });
  await page.locator('#receipt-category').selectOption({ label: category });
}
try {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#home-summary')?.textContent?.includes('今月の支出'));
  await addAccount('Synthetic Wallet');
  await accountDetail('Synthetic Wallet'); await click('編集する');
  await page.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Cash'); await click('変更を保存');
  await page.getByText('支払元：Synthetic Cash', { exact: true }).waitFor();
  await addAccount('Synthetic Closed'); await accountDetail('Synthetic Closed'); await click('利用終了');
  await page.getByText('状態：利用終了', { exact: true }).waitFor(); await click('利用を再開する');
  await page.getByText('状態：利用中', { exact: true }).waitFor(); await click('利用終了');
  await page.getByText('状態：利用終了', { exact: true }).waitFor();
  await addCategory('Synthetic Extra'); await categoryDetail('Synthetic Extra'); await click('編集する');
  await page.getByLabel('カテゴリ名', { exact: true }).fill('Synthetic Hobby'); await click('変更を保存');
  await page.getByText('カテゴリ名：Synthetic Hobby', { exact: true }).waitFor();
  await click('カテゴリを非表示にする'); await page.getByText('状態：非表示', { exact: true }).waitFor();
  await newReceipt();
  assert.equal(await page.locator('#receipt-category option').filter({ hasText: 'Synthetic Hobby' }).count(), 0);
  await categoryDetail('Synthetic Hobby'); await click('カテゴリを表示する');
  await page.getByText('状態：表示中', { exact: true }).waitFor();
  await addCategory('Synthetic Salary', true);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#home-summary')?.textContent?.includes('今月の支出'));
  await settings('カテゴリ'); await click('収入カテゴリ');
  await page.getByRole('button', { name: /^Synthetic Salary ·/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Synthetic Hobby ·/ }).count(), 0);
  if (process.env.PWA_MASTER_CATEGORY_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_MASTER_CATEGORY_SCREENSHOT_PATH, fullPage: true });
  await noOverflow();

  // Draft references to deleted masters must require an explicit new selection.
  await addAccount('Synthetic Temporary'); await addCategory('Synthetic Temporary Category');
  await fillReceipt('Synthetic Draft Shop', 'Synthetic Temporary', 'Synthetic Temporary Category');
 await page.getByText('入力内容を端末に保存しました。', { exact: true }).waitFor();
  await categoryDetail('Synthetic Temporary Category'); page.once('dialog', dialog => dialog.accept()); await click('カテゴリを削除する');
  await page.getByRole('button', { name: 'カテゴリを追加する', exact: true }).waitFor();
  await accountDetail('Synthetic Temporary');
  await page.locator('.master-checkbox').check(); page.once('dialog', dialog => dialog.accept()); await click('完全に削除する');
  await page.getByRole('button', { name: '支払元を追加する', exact: true }).waitFor();
  await page.locator('#receipt-tab').click(); await page.getByRole('button', { name: /^未入力のレシート/ }).first().click();
  // The saved draft belongs to a receipt with no confirmed merchant yet.
  await page.getByText('以前の支払元は利用できません。支払元を選び直してください。', { exact: true }).waitFor();
  await page.getByText('以前のカテゴリは利用できません。カテゴリを選び直してください。', { exact: true }).waitFor();
  assert.equal(await page.locator('#receipt-merchant').inputValue(), 'Synthetic Draft Shop');
  assert.equal(await page.locator('#receipt-account').inputValue(), '');
  assert.equal(await page.locator('#receipt-category').inputValue(), '');
  await page.locator('#receipt-account').selectOption({ label: 'Synthetic Cash' });
  await page.locator('#receipt-category').selectOption({ label: 'Synthetic Hobby' });
  assert.equal(await page.locator('#receipt-category option').filter({ hasText: 'Synthetic Salary' }).count(), 0);
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
  await categoryDetail('Synthetic Hobby');
  await page.getByText('このカテゴリには記録があります。履歴を残すため削除できません。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'カテゴリを削除する', exact: true }).count(), 0);
  await accountDetail('Synthetic Cash');
  assert.equal(await page.getByRole('button', { name: '完全に削除する', exact: true }).count(), 0);
  await click('利用終了'); await page.getByText(/残高がある支払元は利用終了にできません/).waitFor();
  if (process.env.PWA_MASTER_ACCOUNT_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_MASTER_ACCOUNT_SCREENSHOT_PATH, fullPage: true });
  await noOverflow();

  // The Actual ZIP inside .kmb must retain renamed, income and closed masters.
  await page.locator('#settings-tab').click();
  const downloadPromise = page.waitForEvent('download'); await page.locator('#backup-export').click();
  const download = await downloadPromise; const path = await download.path(); assert.ok(path);
  const buffer = await readFile(path);
  const navigation = page.waitForNavigation({ waitUntil: 'load' });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#backup-file').setInputFiles({ name: 'synthetic-masters.kmb', mimeType: 'application/vnd.kakeimatch.backup', buffer });
  await navigation;
  await page.waitForFunction(() => document.querySelector('#home-summary')?.textContent?.includes('今月の支出'));
  await accountDetail('Synthetic Closed', true);
  await settings('カテゴリ'); await click('収入カテゴリ'); await page.getByRole('button', { name: /^Synthetic Salary ·/ }).waitFor();
  await page.locator('#receipt-tab').click(); await page.getByRole('button', { name: /^Synthetic Draft Shop/ }).click();
  await page.getByText('家計簿へ登録済みです。', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Synthetic Draft Shop', exact: true }).waitFor();
  await page.getByText('Synthetic Hobby · Synthetic Cash', { exact: true }).waitFor();
  assert.equal(await page.locator('#receipt-account').count(), 0);
  assert.equal(await page.locator('#receipt-category').count(), 0);
  await page.locator('#home-tab').click(); assert.equal(await page.locator('#transactions li').count(), 1);
  await context.setOffline(true);
  await addCategory('Synthetic Offline Category');
  await categoryDetail('Synthetic Offline Category');
  await page.getByText('カテゴリ名：Synthetic Offline Category', { exact: true }).waitFor();
  await context.setOffline(false);
  assert.deepEqual(errors, []);
  console.log('master management E2E passed: income/expense, CRUD safety, draft reselection, reload, backup/restore and mobile layout');
} catch (error) {
  console.error('Synthetic master page state:', await page.locator('main').innerText());
  throw error;
} finally { await context.close(); await browser.close(); }
