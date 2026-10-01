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
async function account(name) {
  await page.locator('#settings-tab').click(); await click('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: `${name} · 利用中`, exact: true }).waitFor();
}
async function category(name, income = false) {
  await page.locator('#settings-tab').click(); await click('カテゴリ'); if (income) await click('収入カテゴリ');
  await click('カテゴリを追加する'); await page.getByLabel('カテゴリ名', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).waitFor();
}
async function manual(kind, name, amount, categoryName, accountName) {
  await page.locator('#home-tab').click(); await click('＋記録'); await click(kind);
  await page.locator('#manual-transaction-payee').waitFor();
  await page.getByLabel(kind === '支出' ? '店名・支払先' : '入金元・内容', { exact: true }).fill(name);
  await page.getByLabel('金額（円）', { exact: true }).fill(String(amount));
  await page.locator('#manual-transaction-category').selectOption({ label: categoryName });
  await page.locator('#manual-transaction-account').selectOption({ label: accountName });
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
async function splitReceipt() {
  await page.locator('#home-tab').click(); await click('＋記録'); await click('レシートから支出');
  await page.locator('#local-view input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64') });
  await page.locator('#receipt-merchant').fill('Synthetic Budget Split');
  await page.locator('#receipt-amount').fill('1400');
  await page.locator('#receipt-category').selectOption({ label: 'Synthetic Budget Food' });
  await page.locator('#receipt-account').selectOption({ label: 'Synthetic Budget Wallet' });
  let index = 0;
  for (const [name, amount, categoryName] of [['Synthetic Budget Apple', '900', 'Synthetic Budget Food'], ['Synthetic Budget Soap', '500', 'Synthetic Budget Home']]) {
    await page.locator('#receipt-merchant').focus(); await click('品目を追加');
    const item = page.locator('[data-receipt-item]').nth(index++); await item.waitFor();
    if (await item.getAttribute('open') === null) await item.locator('summary').click();
    await item.locator('[data-item-name]').fill(name); await item.locator('[data-item-amount]').fill(amount);
    await item.locator('[data-item-category]').selectOption({ label: categoryName });
  }
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
async function editor() { await page.locator('#settings-tab').click(); await click('予算設定'); await page.locator('#budget-edit-month').waitFor(); }
async function setBudget(month, categoryName, amount) {
  await editor();
  if (month === '2026年9月') await page.getByRole('button', { name: '予算の前月へ', exact: true }).click();
  if (month === '2026年11月') await page.getByRole('button', { name: '予算の翌月へ', exact: true }).click();
  await page.getByRole('heading', { name: `${month}の予算`, exact: true }).waitFor();
  await page.locator('#budget-category').selectOption({ label: categoryName });
  await page.locator('#budget-amount').fill(String(amount));
  await click('予算を保存'); await page.getByText('予算を保存しました。', { exact: true }).waitFor();
}
async function homeMonth(month) { await page.locator('#home-tab').click(); await page.locator('#selected-month').getByText(month, { exact: true }).waitFor(); await page.waitForFunction(() => document.querySelector('#home-summary')?.getAttribute('aria-busy') === 'false'); }
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await account('Synthetic Budget Wallet'); await account('Synthetic Budget Bank');
  await category('Synthetic Budget Food'); await category('Synthetic Budget Home');
  await category('Synthetic Budget Salary', true); await category('Synthetic Custom Budget');
  await manual('支出', 'Synthetic Budget Expense', 1500, 'Synthetic Budget Food', 'Synthetic Budget Wallet');
  await manual('収入', 'Synthetic Budget Income', 200000, 'Synthetic Budget Salary', 'Synthetic Budget Bank');
  await page.locator('#home-tab').click(); await click('＋記録'); await click('口座間振替');
  await page.getByLabel('金額（円）', { exact: true }).fill('8000');
  await page.getByLabel('振替元口座', { exact: true }).selectOption({ label: 'Synthetic Budget Bank' });
  await page.getByLabel('振替先口座', { exact: true }).selectOption({ label: 'Synthetic Budget Wallet' });
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
  await splitReceipt();

  await setBudget('2026年10月', 'Synthetic Budget Food', 2000);
  await setBudget('2026年10月', 'Synthetic Budget Home', 1000);
  await homeMonth('2026年10月');
  let summary = page.locator('details.monthly-budget-details');
  await summary.locator('summary').getByText('10月の予算 · ¥2,900 / ¥3,000', { exact: true }).waitFor();
  await summary.locator('summary').click();
  await page.locator('#budget-total').getByText('予算対象カテゴリの合計：¥2,900 / ¥3,000 · 残り ¥100 · 96.7%', { exact: true }).waitFor();
  await page.locator('[data-budget-category]').filter({ hasText: 'Synthetic Budget Food · ¥2,400 / ¥2,000 · 超過 ¥400 · 120.0%' }).waitFor();
  await page.locator('[data-budget-category]').filter({ hasText: 'Synthetic Budget Home · ¥500 / ¥1,000 · 残り ¥500 · 50.0%' }).waitFor();
  if (process.env.PWA_BUDGET_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_BUDGET_SCREENSHOT_PATH, fullPage: true });

  // Budget views navigate month-by-month and store a separate budget for each category-month.
  await editor(); await page.getByRole('button', { name: '予算の前月へ', exact: true }).click();
  await page.getByRole('heading', { name: '2026年9月の予算', exact: true }).waitFor();
  await page.getByRole('button', { name: '設定へ戻る', exact: true }).click(); await homeMonth('2026年9月');
  await page.getByText('9月の予算 · ¥0 / ¥0', { exact: true }).waitFor();
  await editor(); await page.getByRole('button', { name: '予算の翌月へ', exact: true }).click();
  await page.getByRole('heading', { name: '2026年10月の予算', exact: true }).waitFor();
  await page.getByRole('button', { name: '予算の翌月へ', exact: true }).click();
  await page.getByRole('heading', { name: '2026年11月の予算', exact: true }).waitFor();
  await page.locator('#budget-category').selectOption({ label: 'Synthetic Custom Budget' });
  await page.locator('#budget-amount').fill('600'); await click('予算を保存');
  await page.getByText('予算を保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '設定へ戻る', exact: true }).click(); await homeMonth('2026年11月');
  await page.getByText('11月の予算 · ¥0 / ¥600', { exact: true }).waitFor();
  await page.getByRole('button', { name: '前月へ', exact: true }).click(); await homeMonth('2026年10月');

  // Zero removes the Food budget, leaving the Home category as the monthly total.
  await editor(); await page.locator('#budget-category').selectOption({ label: 'Synthetic Budget Food' });
  assert.equal(await page.locator('#budget-amount').inputValue(), '2000');
  await page.locator('#budget-amount').fill('0'); await click('予算を保存');
  await page.getByText('予算を保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '設定へ戻る', exact: true }).click(); await homeMonth('2026年10月');
  await page.locator('details.monthly-budget-details summary').click();
  await page.locator('#budget-total').getByText('予算対象カテゴリの合計：¥500 / ¥1,000 · 残り ¥500 · 50.0%', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-budget-category]').filter({ hasText: 'Synthetic Budget Food' }).count(), 0);
  await page.reload(); await page.locator('#selected-month').getByText('2026年10月', { exact: true }).waitFor();
  await page.locator('details.monthly-budget-details summary').click();
  await page.locator('#budget-total').getByText('予算対象カテゴリの合計：¥500 / ¥1,000 · 残り ¥500 · 50.0%', { exact: true }).waitFor();
  await context.setOffline(true);
  await editor(); await page.locator('#budget-category').selectOption({ label: 'Synthetic Budget Home' });
  await page.locator('#budget-amount').fill('1200'); await click('予算を保存');
  await page.getByText('予算を保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '設定へ戻る', exact: true }).click(); await homeMonth('2026年10月');
  await page.locator('details.monthly-budget-details summary').click();
  await page.locator('#budget-total').getByText('予算対象カテゴリの合計：¥500 / ¥1,200 · 残り ¥700 · 41.7%', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  await context.setOffline(false);
  console.log('PASS: monthly category budgets, overspend/usage percentages, month-specific custom budgets, zero removal, reload and offline editing');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; } finally { await browser.close(); }
