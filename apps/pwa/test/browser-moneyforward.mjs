import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { waitForBackupExportReady } from './backup-e2e-helpers.mjs';
import { chromium } from 'playwright-core';
const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to an isolated synthetic local PWA.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const aiRequests = []; await context.route('**/api/**', route => { aiRequests.push(route.request().url()); return route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }); });
const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();
const csv = '計算対象,日付,内容,金額（円）,保有金融機関,大項目,中項目,メモ,振替,ID\n1,2026/10/01,架空スーパー,-1200,合成口座,食費,食料品,合成メモ,0,mf-expense\n1,2026/10/02,架空給与,200000,合成口座,給与,給与,,0,mf-income\n1,2099/01/01,架空将来,-450,合成口座,食費,食料品,,0,mf-future\n1,2026/10/03,架空振替,-500,合成口座,現金・カード,ATM引出,,1,mf-transfer\n0,2026/10/03,架空対象外,-900,合成口座,食費,食料品,,0,mf-excluded\n1,2026/10/04,,-300,合成口座,独自用途,試験,,0,\n,,,,,,,,,\n1,2026/99/01,架空不正日付,-100,合成口座,食費,食料品,,0,mf-invalid';
async function open() { await page.locator('#settings-tab').click(); await click('バックアップと復元'); await click('マネーフォワードから移行'); }
async function upload() { await page.locator('#moneyforward-file').setInputFiles({ name: 'synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) }); await click('取り込み内容を確認する'); }
try {
  await page.clock.setFixedTime(new Date('2026-10-08T03:00:00Z'));
  await page.goto(url); await page.getByText('今月の支出 ¥0', { exact: false }).waitFor();
  await open();
  await page.locator('#moneyforward-file').setInputFiles({ name: 'synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('heading', { name: 'カテゴリをまとめて変換' }).waitFor();
  const unknown = page.getByRole('combobox', { name: '独自用途 / 試験（支出） 1件の変換先', exact: true });
  await click('取り込み内容を確認する');
  await page.getByText('未解決のカテゴリがあります。変換先を選ぶか、未分類・除外を選んでください。').waitFor();
  await click('対応を変更する'); await unknown.selectOption('unclassified');
  await click('取り込み内容を確認する');
  await page.getByText('振替（除外）', { exact: true }).waitFor();
  await page.locator('[data-detail="将来日付（除外）"]').getByText('1件', { exact: true }).waitFor();
  await page.locator('.moneyforward-preview-row').filter({ hasText: '内容なし' }).waitFor();
  assert.equal(await page.getByText(/内容がありません|日付を確認できません/).count(), 1, 'only the intentionally invalid date should be reported');
  assert.equal(await page.getByRole('button', { name: '3件を取り込む', exact: true }).count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.PWA_MONEYFORWARD_SCREENSHOT_PATH) {
    const bounds = await page.getByRole('button', { name: '3件を取り込む', exact: true }).boundingBox();
    const navBounds = await page.locator('nav.app-nav').boundingBox();
    assert.ok(bounds && navBounds && bounds.y + bounds.height <= navBounds.y, 'primary action must stay above navigation');
    await page.screenshot({ path: process.env.PWA_MONEYFORWARD_SCREENSHOT_PATH });
  }
  await page.getByLabel('この対応を今後も使用する').check();
  await click('3件を取り込む'); await page.getByRole('heading', { name: '取り込み結果' }).waitFor();
  await page.locator('#receipt-tab').click(); await page.getByRole('button', { name: /架空スーパー/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /架空振替/ }).count(), 0);
  await open(); await upload();
  await page.locator('[data-detail="重複（スキップ）"]').getByText('3件', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /件を取り込む/ }).count(), 0, 'reimport must skip all provider IDs');
  // A different CSV ID must still review the record already in the local ledger.
  const similarCsv = '日付,内容,金額（円）,保有金融機関,大項目,中項目,ID\n2026/10/02,架空類似店舗,-1200,合成口座,食費,食料品,mf-similar';
  await click('対応を変更する'); await click('別のCSVを選ぶ');
  await page.locator('#moneyforward-file').setInputFiles({ name: 'similar.csv', mimeType: 'text/csv', buffer: Buffer.from(similarCsv) });
  await click('取り込み内容を確認する');
  await page.getByText('似ている記録について、統一するか別の記録として取り込むかを選んでください。').waitFor();
  assert.equal(await page.getByRole('button', { name: /件を取り込む/ }).count(), 0);
  const review = page.getByRole('combobox', { name: 'CSV 2行の既存記録との扱い' });
  const existingId = await review.locator('option').filter({ hasText: '既存記録に統一:' }).getAttribute('value');
  assert.ok(existingId);
  await review.selectOption(existingId);
  await page.getByRole('button', { name: '既存記録への統一を確定する', exact: true }).waitFor();
  if (process.env.PWA_MONEYFORWARD_REVIEW_SCREENSHOT_PATH) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: process.env.PWA_MONEYFORWARD_REVIEW_SCREENSHOT_PATH, fullPage: true });
  }
  await click('既存記録への統一を確定する');
  await page.getByRole('heading', { name: '取り込み結果' }).waitFor();
  await page.getByText('移行履歴・取り消し', { exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'この移行を取り消す', exact: true }).last().click();
  await page.getByText('移行した取引を取り消しました。カテゴリと支払元は残っています。').waitFor();
  await page.locator('#moneyforward-file').setInputFiles({ name: 'similar.csv', mimeType: 'text/csv', buffer: Buffer.from(similarCsv) });
  await click('取り込み内容を確認する'); await review.selectOption('separate');
  await click('1件を取り込む'); await page.getByRole('heading', { name: '取り込み結果' }).waitFor();
  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥2,700', { exact: false }).waitFor();
  await open(); await page.getByText('移行履歴・取り消し', { exact: true }).click();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'この移行を取り消す', exact: true }).last().click();
  await page.getByText('移行した取引を取り消しました。カテゴリと支払元は残っています。').waitFor();
  await page.reload(); await page.getByText('今月の支出 ¥1,500', { exact: false }).waitFor();
  await page.locator('#settings-tab').click(); await click('バックアップと復元');
  const downloadPromise = page.waitForEvent('download'); await page.locator('#backup-export').click();
  const download = await downloadPromise; await waitForBackupExportReady(page);
  const backupPath = await download.path(); assert.ok(backupPath);
  const backup = await readFile(backupPath);
  page.once('dialog', dialog => dialog.accept()); const restored = page.waitForNavigation({ waitUntil: 'load' });
  await page.locator('#backup-file').setInputFiles({ name: 'synthetic-mf.kmb', mimeType: 'application/octet-stream', buffer: backup });
  await restored; await page.getByText('今月の支出 ¥1,500', { exact: false }).waitFor(); await open();
  await page.getByText('移行履歴・取り消し', { exact: true }).click();
  page.once('dialog', dialog => dialog.accept()); await click('この移行を取り消す');
  await page.getByText('移行した取引を取り消しました。カテゴリと支払元は残っています。').waitFor();
  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥0', { exact: false }).waitFor();
  assert.equal(aiRequests.some(url => url.includes('/api/ai/')), false, 'CSV import must work without AI or sending transaction data');
  assert.deepEqual(errors, []);
  console.log('PASS: MoneyForward category preview, local import, exclusion, duplicate prevention and journal undo after reload and .kmb restore.');
} catch (error) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: '/tmp/moneyforward-failure.png', fullPage: true }); throw error; } finally { await browser.close(); }
