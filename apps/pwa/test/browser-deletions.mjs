import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { waitForBackupExportReady } from './backup-e2e-helpers.mjs';
if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage(); await page.clock.install({ time: new Date('2026-10-01T03:00:00Z') });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();
async function account(name) { await page.locator('#settings-tab').click(); await click('支払元'); await click('支払元を追加する'); await page.getByLabel('支払元の名前', { exact: true }).fill(name); await click('追加する'); await page.getByRole('button', { name: `${name} · 利用中`, exact: true }).waitFor(); }
async function category(name, income) { await page.locator('#settings-tab').click(); await click('カテゴリ'); if (income) await click('収入カテゴリ'); await click('カテゴリを追加する'); await page.getByLabel('カテゴリ名', { exact: true }).fill(name); await click('追加する'); await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).waitFor(); }
async function manual(name, kind, amount, categoryName) {
  await page.locator('#home-tab').click(); await click('記録を追加'); await click(kind === '支出' ? '支出を手入力' : kind); await page.locator('#manual-transaction-payee').waitFor();
  await page.getByLabel(kind === '支出' ? '店名・支払先' : '入金元・内容', { exact: true }).fill(name);
  await page.getByLabel('金額（円）', { exact: true }).fill(String(amount));
  await page.locator('#manual-transaction-category').selectOption({ label: categoryName });
  await page.locator('#manual-transaction-account').selectOption({ label: 'Synthetic Bank' }); await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
async function detail(name) { await page.locator('#receipt-tab').click(); await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).click(); await page.getByRole('button', { name: '削除する', exact: true }).waitFor(); }
async function remove() { page.once('dialog', dialog => dialog.accept()); await click('削除する'); await page.getByText('削除しました。', { exact: true }).waitFor(); }
async function records() {
  return page.evaluate(() => new Promise((resolve, reject) => { const open = indexedDB.open('kakeimatch-local-data'); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result; const tx = db.transaction(['records', 'blobs']); const data = tx.objectStore('records').getAll(); const blobs = tx.objectStore('blobs').getAll(); tx.oncomplete = () => { resolve({ records: data.result.filter(row => row.profileId === localStorage.getItem('kakeimatch.local-profile.v1')), blobs: blobs.result.filter(row => row.profileId === localStorage.getItem('kakeimatch.local-profile.v1')).map(blob => ({ id: blob.id })) }); db.close(); }; }; }));
}
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await account('Synthetic Bank'); await account('Synthetic Wallet'); await category('Synthetic Food', false); await category('Synthetic Household', false); await category('Synthetic Salary', true);
  await manual('Synthetic Expense', '支出', 1500, 'Synthetic Food'); await manual('Synthetic Income', '収入', 200000, 'Synthetic Salary');
  await detail('Synthetic Expense'); page.once('dialog', dialog => dialog.dismiss()); await click('削除する'); assert.equal(await page.getByRole('button', { name: '削除する', exact: true }).count(), 1);
  await remove(); assert.equal(await page.getByRole('button', { name: /^Synthetic Expense ·/ }).count(), 0);
  if (process.env.PWA_DELETION_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_DELETION_SCREENSHOT_PATH, fullPage: true });
  await click('元に戻す'); await page.getByText('削除を取り消しました。', { exact: true }).waitFor();
  await detail('Synthetic Income'); await remove();
  await page.locator('#home-tab').click();
  await page.getByText('削除しました。', { exact: true }).waitFor();
  await page.clock.fastForward(11000);
  assert.equal(await page.getByRole('button', { name: '元に戻す', exact: true }).count(), 0);
  assert.equal(await page.getByText('削除しました。', { exact: true }).count(), 0);
  assert.equal(await page.locator('.deletion-toast').isVisible(), false);
  if (process.env.PWA_DELETION_EXPIRED_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_DELETION_EXPIRED_SCREENSHOT_PATH, fullPage: true });
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('口座間の振替'); await page.getByLabel('振替先口座', { exact: true }).waitFor();
  await page.getByLabel('金額（円）', { exact: true }).fill('10000'); await page.getByLabel('振替元口座', { exact: true }).selectOption({ label: 'Synthetic Bank' }); await page.getByLabel('振替先口座', { exact: true }).selectOption({ label: 'Synthetic Wallet' });
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: / · 振替 · / }).click(); await remove(); assert.equal(await page.getByRole('button', { name: / · 振替 · / }).count(), 0);
  await click('元に戻す'); await page.getByText('削除を取り消しました。', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: / · 振替 · / }).count(), 1);
  await page.locator('#home-tab').click(); await click('記録を追加');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64') });
  await page.locator('#receipt-merchant').fill('Synthetic Split'); await page.locator('#receipt-amount').fill('1400'); await page.locator('#receipt-category').selectOption({ label: 'Synthetic Food' }); await page.locator('#receipt-account').selectOption({ label: 'Synthetic Bank' });
  let itemIndex = 0;
  for (const [name, amount, categoryName] of [['Synthetic Apple', '900', 'Synthetic Food'], ['Synthetic Soap', '500', 'Synthetic Household']]) {
    await click('品目一覧');
    await click('品目を追加'); const item = page.locator('[data-receipt-item]').nth(itemIndex++); await item.waitFor();
    if (await item.getAttribute('open') === null) await item.locator('summary').click(); await item.locator('[data-item-name]').fill(name); await item.locator('[data-item-amount]').fill(amount); await item.locator('[data-item-category]').selectOption({ label: categoryName });
  }
  await click('全体');
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
  await detail('Synthetic Split'); const before = await records(); const splitRecord = before.records.find(row => row.kind === 'receipt-metadata' && row.value.confirmedValue?.merchant === 'Synthetic Split'); const original = splitRecord.value.registration.actualTransactionId;
  await remove(); let snapshot = await records(); assert.equal(snapshot.blobs.length, 1); assert.equal(snapshot.records.find(row => row.id === splitRecord.id).value.registration.status, 'deleted');
  await click('元に戻す'); await page.getByText('削除を取り消しました。', { exact: true }).waitFor();
  snapshot = await records(); assert.equal(snapshot.records.find(row => row.id === splitRecord.id).value.registration.actualTransactionId, original);
  await detail('Synthetic Split'); await remove(); await page.clock.fastForward(11000);
  await page.locator('#settings-tab').click(); const downloadPromise = page.waitForEvent('download'); await page.locator('#settings-tab').click(); await page.getByRole('button', { name: 'バックアップと復元', exact: true }).click(); await page.locator('#backup-export').click(); const download = await downloadPromise; const buffer = await readFile(await download.path());
  await waitForBackupExportReady(page);
  const navigation = page.waitForNavigation({ waitUntil: 'load' }); page.once('dialog', dialog => dialog.accept()); await page.locator('#backup-file').setInputFiles({ name: 'synthetic-deleted.kmb', mimeType: 'application/vnd.kakeimatch.backup', buffer }); await navigation;
  await page.getByText('今月の支出 ¥1,500', { exact: false }).waitFor(); await page.locator('#receipt-tab').click();
  assert.equal(await page.getByRole('button', { name: /^Synthetic Income ·/ }).count(), 0); assert.equal(await page.getByRole('button', { name: /^Synthetic Split ·/ }).count(), 0);
  snapshot = await records(); assert.ok(snapshot.blobs.some(blob => blob.id === splitRecord.value.image.blobId)); assert.equal(snapshot.records.filter(row => row.kind === 'receipt-metadata' && row.value.registration.status === 'deleted').length, 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepEqual(errors, []);
  console.log('PASS: confirm/cancel, expense/income/split/transfer deletion and Undo, stable IDs, expiration, receipt originals retained, no resurrection after backup/reload');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; } finally { await browser.close(); }
