import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a dedicated synthetic PWA.');
const directory = new URL('./fixtures/actual-26.9.0/', import.meta.url);
const archivePath = new URL('household.kmb', directory);
const metadataPath = new URL('provenance.json', directory);
const generating = process.env.PWA_GENERATE_ACTUAL_COMPAT_FIXTURE === '26.9.0';
if (process.env.PWA_GENERATE_ACTUAL_COMPAT_FIXTURE && !generating) throw new Error('Unsupported fixture generation version.');
const browser = await chromium.launch({ headless: true,
  ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-09-30T03:00:00Z'));
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();

async function ready() {
  await page.locator('#home-tab').click();
  await page.waitForFunction(() => document.querySelector('#home-summary')?.getAttribute('aria-busy') === 'false');
}
async function settings(name) {
  await page.locator('#settings-tab').click();
  if (name) await click(name);
}
async function importArchive(bytes) {
  await settings();
  const navigation = page.waitForNavigation({ waitUntil: 'load' });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#backup-file').setInputFiles({ name: 'synthetic-compatibility.kmb',
    mimeType: 'application/vnd.kakeimatch.backup', buffer: bytes });
  await navigation;
  await ready();
}
async function exportArchive() {
  await settings();
  const downloaded = page.waitForEvent('download');
  await page.locator('#backup-export').click();
  const download = await downloaded;
  assert.match(download.suggestedFilename(), /\.kmb$/);
  await page.waitForFunction(() => document.querySelector('#backup-settings [role=status]')?.textContent?.includes('バックアップを生成しました。')
    && !document.querySelector('#backup-settings')?.closest('[inert]'));
  return readFile(await download.path());
}
async function checkHousehold() {
  await page.locator('#home-tab').click();
  await page.getByText('今月の支出 ¥4,000', { exact: false }).waitFor();
  for (const payee of ['Compatibility Employer', 'Compatibility Cash Shop', 'Compatibility Bank Shop']) {
    await page.locator('#transactions').getByText(payee, { exact: false }).waitFor();
  }
  await settings('支払元');
  for (const [name, expected] of [['Compatibility Cash', '¥6,500'], ['Compatibility Bank', '¥189,500']]) {
    const account = page.getByRole('button', { name: new RegExp(`^${name} ·`) });
    await account.waitFor();
    assert.equal((await account.locator('.account-balance').innerText()).trim(), expected);
  }
  await settings('カテゴリ');
  await page.getByRole('button', { name: /^Compatibility Food ·/ }).waitFor();
  await click('収入カテゴリ');
  await page.getByRole('button', { name: /^Compatibility Salary ·/ }).waitFor();
}
async function seed() {
  for (const name of ['Compatibility Cash', 'Compatibility Bank']) {
    await settings('支払元'); await click('支払元を追加する');
    await page.getByLabel('支払元の名前', { exact: true }).fill(name);
    await click('追加する'); await page.getByRole('button', { name: `${name} · 利用中`, exact: true }).waitFor();
  }
  for (const [name, income] of [['Compatibility Food', false], ['Compatibility Salary', true]]) {
    await settings('カテゴリ');
    if (income) await click('収入カテゴリ');
    await click('カテゴリを追加する'); await page.getByLabel('カテゴリ名', { exact: true }).fill(name);
    await click('追加する'); await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).waitFor();
  }
  for (const [kind, payee, amount, category, account] of [
    ['収入', 'Compatibility Employer', 200000, 'Compatibility Salary', 'Compatibility Bank'],
    ['支出', 'Compatibility Cash Shop', 1500, 'Compatibility Food', 'Compatibility Cash'],
    ['支出', 'Compatibility Bank Shop', 2500, 'Compatibility Food', 'Compatibility Bank'],
  ]) {
    await page.locator('#home-tab').click(); await click('記録を追加'); await click(kind === '支出' ? '支出を手入力' : kind);
    await page.locator('#manual-transaction-payee').fill(payee);
    await page.locator('#manual-transaction-amount').fill(String(amount));
    await page.locator('#manual-transaction-date').fill('2026-09-30');
    await page.locator('#manual-transaction-category').selectOption({ label: category });
    await page.locator('#manual-transaction-account').selectOption({ label: account });
    await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
  }
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('口座間振替');
  await page.getByLabel('金額（円）', { exact: true }).fill('8000');
  await page.getByLabel('日付', { exact: true }).fill('2026-09-30');
  await page.getByLabel('振替元口座', { exact: true }).selectOption({ label: 'Compatibility Bank' });
  await page.getByLabel('振替先口座', { exact: true }).selectOption({ label: 'Compatibility Cash' });
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
try {
  await page.goto(url); await ready();
  if (generating) {
    const installed = JSON.parse(await readFile(new URL('../node_modules/@actual-app/api/package.json', import.meta.url), 'utf8'));
    assert.equal(installed.version, '26.9.0', 'Never regenerate the old fixture with a newer Actual version.');
    const commit = process.env.PWA_FIXTURE_SOURCE_COMMIT;
    assert.match(commit ?? '', /^[a-f0-9]{40}$/, 'Record the source commit used for the preview build.');
    await seed(); await checkHousehold();
    const bytes = await exportArchive();
    // Exclusive creation prevents normal runs or accidental regeneration from replacing the baseline.
    await writeFile(archivePath, bytes, { flag: 'wx' });
    await writeFile(metadataPath, JSON.stringify({ actualVersion: installed.version, sourceCommit: commit,
      sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength,
      syntheticOnly: true, date: '2026-09-30', accounts: 2, categories: 2,
      transactions: 'income, two expenses, paired transfer', expenseYen: 4000,
      balancesYen: { 'Compatibility Cash': 6500, 'Compatibility Bank': 189500 } }, null, 2) + '\n', { flag: 'wx' });
    console.log('Created synthetic Actual 26.9.0 compatibility baseline.');
  } else {
    const bytes = await readFile(archivePath);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    assert.equal(metadata.actualVersion, '26.9.0');
    assert.equal(metadata.syntheticOnly, true);
    assert.equal(bytes.byteLength, metadata.sizeBytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
    await importArchive(bytes); await checkHousehold();
    await page.reload(); await ready(); await checkHousehold();
    const exported = await exportArchive();
    await importArchive(exported); await checkHousehold();
    await settings();
    const navigation = page.waitForNavigation({ waitUntil: 'load' });
    page.once('dialog', dialog => dialog.accept()); await page.locator('#restore-previous').click();
    await navigation; await ready(); await checkHousehold();
    // Wait for the production service worker to control this profile before the offline restart.
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active);
    await page.reload(); await ready();
    assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
    await context.setOffline(true); await page.reload(); await ready(); await checkHousehold();
    assert.deepEqual(errors, []);
    console.log('PASS Actual 26.9.0 baseline: existing household, accounts/categories/transactions/balances, export/restore, previous profile and offline restart.');
  }
} catch (error) {
  console.error('Compatibility page state:', await page.locator('body').innerText());
  console.error('Browser errors:', errors);
  throw error;
} finally { await browser.close(); }
