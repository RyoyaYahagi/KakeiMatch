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
  await page.locator('#home-tab').click(); await click('記録を追加'); await click(kind === '支出' ? '支出を手入力' : kind);
  await page.locator('#manual-transaction-payee').waitFor();
  await page.getByLabel(kind === '支出' ? '店名・支払先' : '入金元・内容', { exact: true }).fill(name);
  await page.getByLabel('金額（円）', { exact: true }).fill(String(amount));
  await page.locator('#manual-transaction-category').selectOption({ label: categoryName });
  await page.locator('#manual-transaction-account').selectOption({ label: accountName });
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
async function splitReceipt() {
  await page.locator('#home-tab').click(); await click('記録を追加');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64') });
  await page.locator('#receipt-merchant').fill('Synthetic Budget Split');
  await page.locator('#receipt-amount').fill('1400');
  await page.locator('#receipt-category').selectOption({ label: 'Synthetic Budget Food' });
  await page.locator('#receipt-account').selectOption({ label: 'Synthetic Budget Wallet' });
  let index = 0;
  for (const [name, amount, categoryName] of [['Synthetic Budget Apple', '900', 'Synthetic Budget Food'], ['Synthetic Budget Soap', '500', 'Synthetic Budget Home']]) {
    await click('品目一覧'); await click('品目を追加');
    const item = page.locator('[data-receipt-item]').nth(index++); await item.waitFor();
    if (await item.getAttribute('open') === null) await item.locator('summary').click();
    await item.locator('[data-item-name]').fill(name); await item.locator('[data-item-amount]').fill(amount);
    await item.locator('[data-item-category]').selectOption({ label: categoryName });
  }
  await click('全体');
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
async function editor() {
  await page.locator('#settings-tab').click(); await click('予算設定'); await page.locator('#budget-edit-month').waitFor();
}
async function categoryBudget(categoryName) {
  const input = page.getByLabel(`${categoryName}の予算`, { exact: true });
  await input.waitFor();
  return input;
}
async function fillBreakdown(entries) {
  for (const [name, amount] of Object.entries(entries)) await (await categoryBudget(name)).fill(String(amount));
}
async function setDefaultPlan(total, breakdown = null) {
  await editor();
  await page.getByLabel('全体予算', { exact: true }).fill(String(total));
  const toggle = page.getByLabel('カテゴリ別にも予算を設定する', { exact: true });
  if (breakdown === null) {
    if (await toggle.isChecked()) await toggle.uncheck();
  } else {
    if (!(await toggle.isChecked())) await toggle.check();
    await fillBreakdown(breakdown);
  }
  await click('基本予算を保存');
  await page.getByText('予算を保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '設定へ戻る', exact: true }).click();
}
async function monthEditor(month) {
  await moveHome(month);
  const summary = page.locator('details.monthly-budget-details');
  await summary.locator('summary').click(); await summary.getByRole('button', { name: 'この月の予算を変更', exact: true }).click();
  await page.getByRole('heading', { name: `${month}の予算`, exact: true }).waitFor();
}
async function setMonthlyPlan(month, total, breakdown = null) {
  await monthEditor(month);
  await page.getByLabel('全体予算', { exact: true }).fill(String(total));
  const toggle = page.getByLabel('カテゴリ別にも予算を設定する', { exact: true });
  if (breakdown === null) {
    if (await toggle.isChecked()) await toggle.uncheck();
  } else {
    if (!(await toggle.isChecked())) await toggle.check();
    await fillBreakdown(breakdown);
  }
  await click('この月の予算を保存');
  await page.getByText('予算を保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '設定へ戻る', exact: true }).click(); await homeMonth(month);
}
async function homeMonth(month) {
  await page.locator('#home-tab').click(); await page.locator('#selected-month').getByText(month, { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#home-summary')?.getAttribute('aria-busy') === 'false');
}
async function moveHome(month) {
  await page.locator('#home-tab').click();
  const parsedTarget = /^(\d{4})年(\d+)月$/.exec(month);
  assert.ok(parsedTarget, `target month was invalid: ${month}`);
  const target = Number(parsedTarget[1]) * 100 + Number(parsedTarget[2]);
  for (let attempts = 0; attempts < 24; attempts++) {
    await page.waitForFunction(() => document.querySelector('#home-summary')?.getAttribute('aria-busy') === 'false');
    const selected = await page.locator('#selected-month').innerText();
    const found = selected.match(/(\d{4})年(\d+)月/);
    assert.ok(found, `selected month was not found in ${selected}`);
    const current = Number(`${found[1]}${String(found[2]).padStart(2, '0')}`);
    if (current === target) return;
    await click(current < target ? '翌月へ' : '前月へ');
  }
  throw new Error(`Could not navigate home to ${month}`);
}

try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await account('Synthetic Budget Wallet'); await account('Synthetic Budget Bank');
  await category('Synthetic Budget Food'); await category('Synthetic Budget Home');
  await category('Synthetic Budget Salary', true); await category('Synthetic Custom Budget');
  await manual('支出', 'Synthetic Budget Expense', 1500, 'Synthetic Budget Food', 'Synthetic Budget Wallet');
  await manual('収入', 'Synthetic Budget Income', 200000, 'Synthetic Budget Salary', 'Synthetic Budget Bank');
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('口座間の振替');
  await page.getByLabel('金額（円）', { exact: true }).fill('8000');
  await page.getByLabel('振替元口座', { exact: true }).selectOption({ label: 'Synthetic Budget Bank' });
  await page.getByLabel('振替先口座', { exact: true }).selectOption({ label: 'Synthetic Budget Wallet' });
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
  await splitReceipt();

  // The simplest path: one overall monthly budget, no category allocation required.
  await setDefaultPlan(5000);
  await homeMonth('2026年10月');
  let summary = page.locator('details.monthly-budget-details');
  await summary.locator('summary').getByText('10月の予算 · ¥2,900 / ¥5,000', { exact: true }).waitFor();
  await summary.locator('summary').click();
  await page.locator('#budget-total').getByText('全体予算：¥2,900 / ¥5,000 · 残り ¥2,100 · 58.0%', { exact: true }).waitFor();
  await page.getByText('カテゴリ別の内訳は設定していません。', { exact: true }).waitFor();

  // Category budgets are optional, but once enabled their sum must equal the overall budget.
  await editor();
  await page.getByLabel('全体予算', { exact: true }).fill('3500');
  const toggle = page.getByLabel('カテゴリ別にも予算を設定する', { exact: true });
  await toggle.check();
  await fillBreakdown({
    'Synthetic Budget Food': 2500,
    'Synthetic Budget Home': 500,
    'Synthetic Custom Budget': 0,
  });
  await click('基本予算を保存');
  await page.getByText('カテゴリ別予算の合計（¥3,000）を全体予算（¥3,500）と一致させてください。', { exact: true }).waitFor();

  await (await categoryBudget('Synthetic Budget Home')).fill('1000');
  await click('基本予算を保存');
  await page.getByText('予算を保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '設定へ戻る', exact: true }).click();
  await homeMonth('2026年10月');
  summary = page.locator('details.monthly-budget-details');
  await summary.locator('summary').click();
  await page.locator('#budget-total').getByText('全体予算：¥2,900 / ¥3,500 · 残り ¥600 · 82.9%', { exact: true }).waitFor();
  await page.locator('[data-budget-category]').filter({ hasText: 'Synthetic Budget Food · ¥2,400 / ¥2,500 · 残り ¥100 · 96.0%' }).waitFor();
  await page.locator('[data-budget-category]').filter({ hasText: 'Synthetic Budget Home · ¥500 / ¥1,000 · 残り ¥500 · 50.0%' }).waitFor();

  // A single month may use a different balanced allocation while later months inherit the default.
  await setMonthlyPlan('2026年12月', 5000, {
    'Synthetic Budget Food': 4000,
    'Synthetic Budget Home': 1000,
    'Synthetic Custom Budget': 0,
  });
  await homeMonth('2026年12月');
  await page.getByText('12月の予算 · ¥0 / ¥5,000', { exact: true }).waitFor();

  // A monthly override can be removed and falls back to the basic monthly plan.
  await monthEditor('2026年12月');
  await click('基本予算に戻す');
  await page.getByText('予算を保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '設定へ戻る', exact: true }).click();
  await homeMonth('2026年12月');
  await page.getByText('12月の予算 · ¥0 / ¥3,500', { exact: true }).waitFor();
  await moveHome('2027年1月');
  await page.getByText('1月の予算 · ¥0 / ¥3,500', { exact: true }).waitFor();

  // A month can also opt out of category allocation and keep only its overall budget.
  await setMonthlyPlan('2026年10月', 4500);
  await page.locator('details.monthly-budget-details summary').click();
  await page.locator('#budget-total').getByText('全体予算：¥2,900 / ¥4,500 · 残り ¥1,600 · 64.4%', { exact: true }).waitFor();
  await page.getByText('カテゴリ別の内訳は設定していません。', { exact: true }).waitFor();

  await page.reload(); await page.locator('#selected-month').getByText('2026年10月', { exact: true }).waitFor();
  await page.locator('details.monthly-budget-details summary').click();
  await page.locator('#budget-total').getByText('全体予算：¥2,900 / ¥4,500 · 残り ¥1,600 · 64.4%', { exact: true }).waitFor();

  await context.setOffline(true);
  await setMonthlyPlan('2026年10月', 4800);
  await page.locator('details.monthly-budget-details summary').click();
  await page.locator('#budget-total').getByText('全体予算：¥2,900 / ¥4,800 · 残り ¥1,900 · 60.4%', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  await context.setOffline(false);
  console.log('PASS: overall-only budgets work, category allocations must match the overall total, monthly overrides inherit correctly, and settings persist offline');
} catch (error) { console.log(await page.locator('body').innerText(), errors); throw error; } finally { await browser.close(); }
