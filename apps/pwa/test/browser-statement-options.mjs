import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
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
const headers = '利用日,利用店名・商品名,利用者,支払方法,利用金額,手数料/利息,支払総額,9月支払金額,当月請求額,10月繰越残高,新規サイン';
const csv = `${headers}\n${[['Synthetic Excluded Purchase', 1200], ['Synthetic Suica Charge', 5000], ['Synthetic Cancelled Purchase', 800]].map(([name, amount]) => `2026/10/01,${name},本人,1回払い,${amount},0,${amount},${amount},${amount},0,`).join('\n')}\n`;
async function upload() {
  if (await page.locator('#reconciliation-tab').getAttribute('aria-pressed') !== 'true') await page.locator('#reconciliation-tab').click();
  await page.locator('#statement-provider').waitFor({ state: 'attached' });
  await page.locator('details.statement-import-disclosure').evaluateAll(rows => { for (const row of rows) row.open = true; });
  await page.locator('#statement-provider').selectOption('rakuten_card');
  await page.locator('#statement-file').setInputFiles({ name: 'synthetic-options.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await click('取り込んで照合');
}
async function review(name) {
  const item = page.locator('details.review-item').filter({ hasText: name }); await item.locator('summary').click(); return item;
}
async function openExcluded() {
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: /Synthetic Excluded Purchase.*−¥1,200/ }).click();
  await page.getByRole('heading', { name: '支出の記録' }).waitFor();
}
async function waitExclusion() { await page.getByText('保存しました。', { exact: true }).waitFor(); }
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await upload(); await page.getByText('3件を取り込み、照合しました。重複 0件。対象外 0件、要確認 0件。', { exact: true }).waitFor();
  const excluded = await review('Synthetic Excluded Purchase');
  assert.equal(await excluded.locator('select[id^="account-"]').count(), 0);
  await excluded.locator('select[id^="category-"]').selectOption({ label: '食費' });
  await excluded.getByLabel('支出の計算に含めない', { exact: true }).check();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: fileURLToPath(new URL('../../../docs/screenshots/ui-statement-expense-options-375.png', import.meta.url)), fullPage: true });
  await excluded.getByRole('button', { name: '支出として登録', exact: true }).click();
  await page.getByText(/記録なし 2件/).waitFor();
  const transfer = await review('Synthetic Suica Charge');
  await transfer.getByLabel('取引の種類').selectOption('transfer');
  await transfer.getByRole('button', { name: '支払元・口座を追加', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Suica');
  await dialog.getByRole('button', { name: '追加する', exact: true }).click(); await dialog.waitFor({ state: 'detached' });
  await page.screenshot({ path: fileURLToPath(new URL('../../../docs/screenshots/ui-statement-transfer-options-375.png', import.meta.url)), fullPage: true });
  await transfer.getByRole('button', { name: '振替として登録', exact: true }).click();
  await page.getByText(/記録なし 1件/).waitFor();
  const cancelled = await review('Synthetic Cancelled Purchase'); await cancelled.getByRole('button', { name: '登録しない', exact: true }).click();
  await page.getByText('確認が必要な明細はありません', { exact: true }).waitFor();
  await page.getByText('登録しないと判断した明細（1件）', { exact: true }).waitFor();
  await upload(); await page.getByText('0件を取り込み、照合しました。重複 3件。対象外 0件、要確認 0件。', { exact: true }).waitFor();
  await page.getByText('確認が必要な明細はありません', { exact: true }).waitFor();
  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥0').waitFor();
  await openExcluded(); assert.equal(await page.getByLabel('支出の計算に含めない', { exact: true }).isChecked(), true);
  await page.getByLabel('支出の計算に含めない', { exact: true }).uncheck(); await waitExclusion();
  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥1,200').waitFor();
  await openExcluded(); await page.getByLabel('支出の計算に含めない', { exact: true }).check(); await waitExclusion();
  await page.locator('#settings-tab').click(); await click('支払元'); await page.getByRole('button', { name: '楽天カード · 利用中', exact: true }).click();
  await page.getByText('差引未払額 ¥6,200', { exact: true }).waitFor();
  await page.locator('#settings-tab').click(); await page.locator('#settings-tab').click(); await click('バックアップと復元');
  const downloadPromise = page.waitForEvent('download'); await page.locator('#backup-export').click();
  const buffer = await readFile(await (await downloadPromise).path());
  await waitForBackupExportReady(page);
  const navigation = page.waitForNavigation({ waitUntil: 'load' }); page.once('dialog', dialog => dialog.accept());
  await page.locator('#backup-file').setInputFiles({ name: 'synthetic-options.kmb', mimeType: 'application/vnd.kakeimatch.backup', buffer });
  await navigation; await page.getByText('今月の支出 ¥0').waitFor();
  await openExcluded(); assert.equal(await page.getByLabel('支出の計算に含めない', { exact: true }).isChecked(), true);
  await page.locator('#reconciliation-tab').click(); await page.getByText('登録しないと判断した明細（1件）').waitFor();
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('支出を手入力');
  await page.locator('#manual-transaction-payee').fill('Synthetic Manual Excluded');
  await page.locator('#manual-transaction-date').fill('2026-10-01'); await page.locator('#manual-transaction-amount').fill('100');
  await page.locator('#manual-transaction-category').selectOption({ label: '食費' }); await page.locator('#manual-transaction-account').selectOption({ label: '楽天カード' });
  await page.getByLabel('支出の計算に含めない', { exact: true }).check(); await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥0').waitFor();
  await openExcluded(); await context.setOffline(true);
  await page.getByLabel('支出の計算に含めない', { exact: true }).uncheck(); await waitExclusion();
  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥1,200').waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: fixed Rakuten source, excluded spending, linked transfer, ignored cancellation, duplicate import, balances, reload and backup restore at 375px.');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; }
finally { await browser.close(); }
