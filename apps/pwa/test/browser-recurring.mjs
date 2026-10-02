import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Tokyo' });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage();
// Actual runs schedules in its Worker, outside Playwright's page-only clock.
// Use the same real Tokyo day so creating a due schedule never skips to next month.
const now = new Date();
const scheduleDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(now);
await page.clock.setFixedTime(now);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();
async function settings(name) { await page.locator('#settings-tab').click(); await click(name); }
async function addAccount(name) {
  await settings('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: `${name} · 利用中`, exact: true }).waitFor();
}
async function addCategory(name, income = false) {
  await settings('カテゴリ'); if (income) await click('収入カテゴリ');
  await click('カテゴリを追加する'); await page.getByLabel('カテゴリ名', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).waitFor();
}
async function recurringList() { await settings('定期登録'); await page.getByRole('heading', { name: '定期登録', exact: true }).waitFor(); }
async function openCreate() { await recurringList(); await click('定期登録を追加する'); await page.locator('#recurring-name').waitFor(); }
async function fill({ name, kind = 'expense', amount, category, account, frequency = 'monthly', startDate = scheduleDate, auto = false }) {
  await page.locator('#recurring-name').fill(name);
  await page.locator('#recurring-kind').selectOption(kind);
  await page.waitForFunction(categoryName => {
    const select = document.querySelector('#recurring-category');
    return select instanceof HTMLSelectElement && !select.disabled && Array.from(select.options).some(option => option.textContent === categoryName);
  }, category);
  await page.locator('#recurring-amount').fill(String(amount));
  await page.locator('#recurring-category').selectOption({ label: category });
  await page.locator('#recurring-account').selectOption({ label: account });
  await page.locator('#recurring-frequency').selectOption(frequency);
  await page.locator('#recurring-start-date').fill(startDate);
  await page.locator('#recurring-auto').setChecked(auto);
}
async function save() { await click('保存する'); }
async function recordNames() {
  await page.locator('#receipt-tab').click();
  return page.locator('.record-list').innerText();
}
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await addAccount('Synthetic Schedule Wallet'); await addAccount('Synthetic Schedule Bank');
  await addCategory('Synthetic Schedule Food'); await addCategory('Synthetic Schedule Salary', true);

  await openCreate();
  await fill({ name: 'Synthetic Monthly Expense', amount: 1500, category: 'Synthetic Schedule Food', account: 'Synthetic Schedule Wallet', auto: true });
  await save(); await page.getByText('定期登録を保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Synthetic Monthly Expense · 支出 ¥1,500', exact: true }).waitFor();
  await page.getByText(/毎月 · 次回 .* · 自動登録 オン/).waitFor();

  // A matching name is rejected before another native schedule is created.
  await click('定期登録を追加する');
  await fill({ name: 'Synthetic Monthly Expense', amount: 1500, category: 'Synthetic Schedule Food', account: 'Synthetic Schedule Wallet', auto: true });
  await save(); await page.getByText('同じ名前の定期登録があります。既存の定期登録を編集してください。', { exact: true }).waitFor();
  assert.equal(await page.locator('#recurring-name').inputValue(), 'Synthetic Monthly Expense');
  await click('一覧へ戻る');

  await openCreate();
  await fill({ name: 'Synthetic Monthly Income', kind: 'income', amount: 200000, category: 'Synthetic Schedule Salary', account: 'Synthetic Schedule Bank', auto: true });
  await save(); await page.getByText('定期登録を保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Synthetic Monthly Income · 収入 ¥200,000', exact: true }).waitFor();

  await openCreate();
  await fill({ name: 'Synthetic Weekly Expense', amount: 700, category: 'Synthetic Schedule Food', account: 'Synthetic Schedule Wallet', frequency: 'weekly', auto: false });
  await save(); await page.getByText('定期登録を保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Synthetic Weekly Expense · 支出 ¥700', exact: true }).waitFor();
  await page.getByText(/毎週 · 次回 .* · 自動登録 オフ/).waitFor();

  await openCreate();
  await fill({ name: 'Synthetic Yearly Expense', amount: 5000, category: 'Synthetic Schedule Food', account: 'Synthetic Schedule Wallet', frequency: 'yearly', auto: false });
  await save(); await page.getByText('定期登録を保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Synthetic Yearly Expense · 支出 ¥5,000', exact: true }).waitFor();
  await page.getByText(/毎年 · 次回 .* · 自動登録 オフ/).waitFor();
  await page.screenshot({ path: '/tmp/issue-72-recurring.png', fullPage: true });

  const beforeEditRecords = await recordNames();
  assert.match(beforeEditRecords, /Synthetic Monthly Expense/);
  assert.match(beforeEditRecords, /Synthetic Monthly Income/);
  assert.doesNotMatch(beforeEditRecords, /Synthetic Weekly Expense|Synthetic Yearly Expense/);
  const generatedTransactionCount = await page.locator('.record-list > li').count();
  assert.equal(generatedTransactionCount, 2);
  await page.getByRole('button', { name: /Synthetic Monthly Expense · .*¥1,500/ }).click();
  await page.getByRole('heading', { name: '支出の記録', exact: true }).waitFor();
  assert.match(await page.locator('.transaction-detail').innerText(), /カテゴリ\s+Synthetic Schedule Food/);
  assert.match(await page.locator('.transaction-detail').innerText(), /金額\s+¥1,500/);
  await click('記録一覧へ戻る');
  await page.getByRole('button', { name: /Synthetic Monthly Income · .*収入 ¥200,000/ }).click();
  await page.getByRole('heading', { name: '収入の記録', exact: true }).waitFor();
  assert.match(await page.locator('.transaction-detail').innerText(), /カテゴリ\s+Synthetic Schedule Salary/);
  assert.match(await page.locator('.transaction-detail').innerText(), /金額\s+¥200,000/);
  page.once('dialog', dialog => dialog.accept()); await click('削除する');
  await page.getByText('削除しました。', { exact: true }).waitFor();
  const afterIncomeDelete = await recordNames();
  assert.doesNotMatch(afterIncomeDelete, /Synthetic Monthly Income/);
  assert.equal(await page.locator('.record-list > li').count(), generatedTransactionCount - 1);
  await recurringList(); await click('Synthetic Monthly Expense · 支出 ¥1,500');
  await page.getByRole('heading', { name: 'Synthetic Monthly Expense', exact: true }).waitFor();
  await click('編集する'); await page.locator('#recurring-amount').waitFor();
  await fill({ name: 'Synthetic Monthly Expense Edited', amount: 1700, category: 'Synthetic Schedule Food', account: 'Synthetic Schedule Wallet', frequency: 'monthly', auto: true });
  await save(); await page.getByText('定期登録を保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Synthetic Monthly Expense Edited · 支出 ¥1,700', exact: true }).waitFor();
  const editedRecords = await recordNames();
  assert.equal(await page.locator('.record-list > li').count(), generatedTransactionCount - 1);
  assert.doesNotMatch(editedRecords, /Synthetic Weekly Expense|Synthetic Yearly Expense/);
  await page.getByRole('button', { name: /Synthetic Monthly Expense · .*¥1,500/ }).click();
  assert.match(await page.locator('.transaction-detail').innerText(), /カテゴリ\s+Synthetic Schedule Food/);
  assert.match(await page.locator('.transaction-detail').innerText(), /金額\s+¥1,500/);
  await click('記録一覧へ戻る');

  // Deleting the schedule keeps its already-generated transaction and prevents future regeneration.
  await recurringList();
  await click('Synthetic Monthly Expense Edited · 支出 ¥1,700'); page.once('dialog', dialog => dialog.accept()); await click('削除する');
  await page.getByText('定期登録を削除しました。生成済みの取引は残っています。', { exact: true }).waitFor();
  const afterDeleteRecords = await recordNames();
  assert.match(afterDeleteRecords, /Synthetic Monthly Expense/);
  await page.reload(); await page.getByText('今月の支出', { exact: false }).waitFor();
  const afterReloadRecords = await recordNames();
  assert.doesNotMatch(afterReloadRecords, /Synthetic Monthly Income/);
  assert.match(afterReloadRecords, /Synthetic Monthly Expense/);
  assert.equal(await page.locator('.record-list > li').count(), generatedTransactionCount - 1);
  await recurringList();
  assert.equal(await page.getByRole('button', { name: /Synthetic Monthly Expense Edited/ }).count(), 0);
  await page.getByRole('button', { name: 'Synthetic Monthly Income · 収入 ¥200,000', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Synthetic Weekly Expense · 支出 ¥700', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Synthetic Yearly Expense · 支出 ¥5,000', exact: true }).waitFor();

  await context.setOffline(true);
  await openCreate();
  await fill({ name: 'Synthetic Offline Schedule', amount: 300, category: 'Synthetic Schedule Food', account: 'Synthetic Schedule Wallet', auto: false });
  await save(); await page.getByText('定期登録を保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Synthetic Offline Schedule · 支出 ¥300', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  await context.setOffline(false);
  console.log('PASS: recurring expense/income details, generated transaction edit invariants, weekly/yearly auto-off, duplicate prevention, delete/reload regeneration guard and offline creation');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; } finally { await browser.close(); }
