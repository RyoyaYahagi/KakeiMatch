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
async function settings(name) { await page.locator('#settings-tab').click(); await click(name); }
async function addAccount(name) {
  await settings('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: `${name} · 利用中`, exact: true }).waitFor();
}
async function closeAccount(name) {
  await settings('支払元'); await click(`${name} · 利用中`); await click('利用終了');
  await page.locator('[data-detail="状態"] dd').getByText('利用終了', { exact: true }).waitFor();
}
async function addCategory(name, income = false) {
  await settings('カテゴリ'); if (income) await click('収入カテゴリ');
  await click('カテゴリを追加する'); await page.getByLabel('カテゴリ名', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).waitFor();
}
async function hideCategory(name) {
  await settings('カテゴリ'); await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).click();
  await click('カテゴリを非表示にする'); await page.locator('[data-detail="状態"] dd').getByText('非表示', { exact: true }).waitFor();
}
async function manual(kind, name, amount, category, account, memo, date) {
  await page.locator('#home-tab').click(); await click('記録を追加'); await click(kind === '支出' ? '支出を手入力' : kind);
  await page.locator('#manual-transaction-payee').fill(name);
  await page.locator('#manual-transaction-amount').fill(String(amount));
  await page.locator('#manual-transaction-date').fill(date);
  await page.locator('#manual-transaction-category').selectOption({ label: category });
  await page.locator('#manual-transaction-account').selectOption({ label: account });
  for (const summary of await page.locator('details.optional-fields:not([open]) > summary').all()) await summary.click(); for (const summary of await page.locator('details.optional-fields:not([open]) > summary').all()) await summary.click(); await page.locator('#manual-transaction-memo').fill(memo);
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
async function splitReceipt() {
  await page.locator('#home-tab').click(); await click('記録を追加');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64') });
  await page.locator('#receipt-merchant').fill('Synthetic Search Market');
  await page.locator('#receipt-date').fill('2026-10-04');
  await page.locator('#receipt-amount').fill('1400');
  await page.locator('#receipt-category').selectOption({ label: 'Synthetic Search Food' });
  await page.locator('#receipt-account').selectOption({ label: 'Synthetic Search Wallet' });
  let index = 0;
  for (const [name, amount, category] of [['Synthetic Search Item Alpha', '900', 'Synthetic Search Food'], ['Synthetic Search Item Beta', '500', 'Synthetic Search Home']]) {
    await click('品目一覧'); await click('品目を追加');
    const item = page.locator('[data-receipt-item]').nth(index++); await item.waitFor();
    if (await item.getAttribute('open') === null) await item.locator('summary').click();
    await item.locator('[data-item-name]').fill(name); await item.locator('[data-item-amount]').fill(amount);
    await item.locator('[data-item-category]').selectOption({ label: category });
  }
  await click('全体');
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
async function transfer() {
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('口座間の振替');
  await page.getByLabel('金額（円）', { exact: true }).fill('8000');
  await page.getByLabel('日付', { exact: true }).fill('2026-10-03');
  await page.getByLabel('振替元口座', { exact: true }).selectOption({ label: 'Synthetic Search Bank' });
  await page.getByLabel('振替先口座', { exact: true }).selectOption({ label: 'Synthetic Search Wallet' });
  for (const summary of await page.locator('details.optional-fields:not([open]) > summary').all()) await summary.click(); await page.getByLabel('メモ（任意）', { exact: true }).fill('Synthetic transfer memo');
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
async function openSearch() {
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: /記録を検索|検索・絞り込み/ }).click();
  await page.getByRole('heading', { name: '記録を検索', exact: true }).waitFor();
  await page.locator('#transaction-search-count').waitFor();
}
async function submit() { await click('検索する'); }
async function openAdvanced() { const details = page.locator('.transaction-search-advanced'); if (await details.getAttribute('open') === null) await details.locator('summary').click(); }
async function matchingCount(count) { await page.locator('#transaction-search-count').getByText(`${count}件`, { exact: true }).waitFor(); }
async function resultText() { return page.locator('#transaction-search-results').innerText(); }
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await addAccount('Synthetic Search Wallet'); await addAccount('Synthetic Search Bank'); await addAccount('Synthetic Closed Search Wallet');
  await addCategory('Synthetic Search Food'); await addCategory('Synthetic Search Home');
  await addCategory('Synthetic Search Hidden'); await addCategory('Synthetic Search Salary', true);
  await manual('支出', 'Synthetic Search Merchant', 1200, 'Synthetic Search Food', 'Synthetic Search Wallet', 'Synthetic expense memo', '2026-10-01');
  await manual('収入', 'Synthetic Search Employer', 200000, 'Synthetic Search Salary', 'Synthetic Search Bank', 'Synthetic income memo', '2026-10-02');
  await manual('支出', 'Synthetic Hidden Merchant', 400, 'Synthetic Search Hidden', 'Synthetic Closed Search Wallet', 'Synthetic hidden memo', '2026-09-15');
  await manual('収入', 'Synthetic Closed Account Income', 400, 'Synthetic Search Salary', 'Synthetic Closed Search Wallet', 'Synthetic closed account memo', '2026-09-15');
  await closeAccount('Synthetic Closed Search Wallet');
  await transfer(); await splitReceipt(); await hideCategory('Synthetic Search Hidden');

  await openSearch();
  await page.locator('#transaction-search-keyword').fill('synthetic search merchant'); await submit();
  await matchingCount(1); assert.match(await resultText(), /Synthetic Search Merchant/);
  await page.locator('#transaction-search-keyword').fill('SYNTHETIC EXPENSE MEMO'); await submit();
  await matchingCount(1); assert.match(await resultText(), /Synthetic Search Merchant/);
  await page.locator('#transaction-search-keyword').fill('Synthetic Search Employer'); await submit();
  await matchingCount(1); assert.match(await resultText(), /収入/);
  await page.locator('#transaction-search-keyword').fill('Synthetic Search Item Beta'); await submit();
  await matchingCount(1); assert.match(await resultText(), /Synthetic Search Market/);

  await page.locator('#transaction-search-keyword').fill('');
  await openAdvanced();
  await page.locator('#transaction-search-category').selectOption({ label: 'Synthetic Search Home' }); await submit();
  await matchingCount(1); assert.match(await resultText(), /Synthetic Search Market/);
  await openAdvanced();
  await page.locator('#transaction-search-category').selectOption({ label: 'Synthetic Search Hidden · 非表示' }); await submit();
  await matchingCount(1); assert.match(await resultText(), /Synthetic Hidden Merchant/);

  await openAdvanced(); await page.locator('#transaction-search-category').selectOption('');
  await page.locator('#transaction-search-keyword').fill(''); await openAdvanced();
  await page.locator('#transaction-search-kind').selectOption('transfer');
  await page.locator('#transaction-search-account').selectOption({ label: 'Synthetic Search Wallet' }); await submit();
  await matchingCount(1); assert.match(await resultText(), /振替先 Synthetic Search Wallet/);

  await page.locator('#transaction-search-keyword').fill('Synthetic transfer memo'); await submit();
  await matchingCount(1);
  assert.match(await resultText(), /振替先 Synthetic Search Wallet/);
  await page.locator('#transaction-search-keyword').fill('');
  await openAdvanced();
  assert.equal(await page.locator('#transaction-search-account option').filter({ hasText: 'Synthetic Closed Search Wallet · 利用終了' }).count(), 1);
  await page.locator('#transaction-search-kind').selectOption('');
  await page.locator('#transaction-search-account').selectOption({ label: 'Synthetic Closed Search Wallet · 利用終了' }); await submit();
  await matchingCount(2); assert.match(await resultText(), /Synthetic Closed Account Income/); assert.match(await resultText(), /Synthetic Hidden Merchant/);
  await openAdvanced(); await page.locator('#transaction-search-account').selectOption('');
  await page.locator('#transaction-search-start-date').fill('2026-10-01');
  await page.locator('#transaction-search-end-date').fill('2026-10-02');
  await page.locator('#transaction-search-kind').selectOption('expense');
  await page.locator('#transaction-search-category').selectOption({ label: 'Synthetic Search Food' });
  await page.locator('#transaction-search-account').selectOption({ label: 'Synthetic Search Wallet' });
  await page.locator('#transaction-search-min-amount').fill('1000');
  await page.locator('#transaction-search-max-amount').fill('1300'); await submit();
  await matchingCount(1); assert.match(await resultText(), /Synthetic Search Merchant/);
  assert.match(await page.locator('.transaction-search-active').innerText(), /種類：支出/);
  assert.match(await page.locator('.transaction-search-active').innerText(), /口座：Synthetic Search Wallet/);
  const selectedAccount = await page.locator('#transaction-search-account').inputValue();
  await page.locator('#transaction-search-results > li > button').click();
  await page.getByRole('heading', { name: 'Synthetic Search Merchant', exact: true }).waitFor();
  await click('検索結果へ戻る');
  await page.locator('#transaction-search-count').getByText('1件', { exact: true }).waitFor();
  assert.equal(await page.locator('#transaction-search-kind').inputValue(), 'expense');
  assert.equal(await page.locator('#transaction-search-account').inputValue(), selectedAccount);
  assert.equal(await page.locator('#transaction-search-start-date').inputValue(), '2026-10-01');
  await matchingCount(1);

  await page.locator('#transaction-search-keyword').fill('No matching synthetic transaction'); await submit();
  await matchingCount(0); await page.getByText('条件に一致する記録はありません。', { exact: true }).waitFor();
  await click('条件をすべて解除');
  assert.equal(await page.locator('#transaction-search-keyword').inputValue(), '');
  assert.equal(await page.locator('#transaction-search-start-date').inputValue(), '');
  assert.equal(await page.locator('#transaction-search-kind').inputValue(), '');
  await matchingCount(6);
  const dates = await page.locator('#transaction-search-results > li > button').evaluateAll(buttons => buttons.map(button => button.dataset.date));
  assert.deepEqual(dates, [...dates].sort((a, b) => b.localeCompare(a)));
  if (process.env.PWA_TRANSACTION_SEARCH_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_TRANSACTION_SEARCH_SCREENSHOT_PATH, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await page.reload(); await page.getByText('今月の支出', { exact: false }).waitFor(); await openSearch();
  await page.locator('#transaction-search-keyword').fill('Synthetic Search Market'); await submit();
  await matchingCount(1);
  await context.setOffline(true);
  await page.locator('#transaction-search-keyword').fill('Synthetic Search Merchant'); await submit();
  await matchingCount(1); assert.deepEqual(errors, []);
  await context.setOffline(false);
  console.log('PASS: keyword sources, hidden/child categories, closed accounts, transfer destinations, combined filters, date ordering, clear/empty/reload/offline and mobile width');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; } finally { await browser.close(); }
