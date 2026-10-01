import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-01T03:00:00Z'));
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();

async function account(name) {
  await page.locator('#settings-tab').click(); await click('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: `${name} · 利用中`, exact: true }).waitFor();
}
async function category(name, income = false) {
  await page.locator('#settings-tab').click(); await click('カテゴリ');
  if (income) await click('収入カテゴリ');
  await click('カテゴリを追加する'); await page.getByLabel('カテゴリ名', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).waitFor();
}
async function manual(kind, name, amount, categoryName, accountName) {
  await page.locator('#home-tab').click(); await click('＋記録'); await click(kind); if (kind === '支出') await click('手入力');
  await page.locator('#manual-transaction-payee').waitFor();
  await page.getByLabel(kind === '支出' ? '店名・支払先' : '入金元・内容', { exact: true }).fill(name);
  await page.getByLabel('金額（円）', { exact: true }).fill(String(amount));
  await page.locator('#manual-transaction-category').selectOption({ label: categoryName });
  await page.locator('#manual-transaction-account').selectOption({ label: accountName });
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
async function transfer(amount, source, destination) {
  await page.locator('#home-tab').click(); await click('＋記録'); await click('口座間振替');
  await page.getByLabel('振替先口座', { exact: true }).waitFor();
  await page.getByLabel('金額（円）', { exact: true }).fill(String(amount));
  await page.getByLabel('振替元口座', { exact: true }).selectOption({ label: source });
  await page.getByLabel('振替先口座', { exact: true }).selectOption({ label: destination });
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
async function splitReceipt() {
  await page.locator('#home-tab').click(); await click('＋記録'); await click('支出'); await click('レシートから入力');
  await page.locator('#local-view input[type=file]').first().setInputFiles({
    name: 'synthetic.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64'),
  });
  await page.locator('#receipt-merchant').fill('Synthetic Split');
  await page.locator('#receipt-amount').fill('1400');
  await page.locator('#receipt-category').selectOption({ label: 'Synthetic Food' });
  await page.locator('#receipt-account').selectOption({ label: 'Synthetic Wallet' });
  let index = 0;
  for (const [name, amount, categoryName] of [['Synthetic Apple', '900', 'Synthetic Food'], ['Synthetic Soap', '500', 'Synthetic Home']]) {
    // Keep the fold from receiving focusout while its layout changes to preserve an entered item's state.
    await page.locator('#receipt-merchant').focus();
    await click('品目を追加');
    const item = page.locator('[data-receipt-item]').nth(index++);
    await item.waitFor();
    if (await item.getAttribute('open') === null) await item.locator('summary').click();
    await item.locator('[data-item-name]').fill(name);
    await item.locator('[data-item-amount]').fill(amount);
    await item.locator('[data-item-category]').selectOption({ label: categoryName });
  }
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
async function waitForMonth(label) { await page.locator('#selected-month').getByText(label, { exact: true }).waitFor(); }
async function totals({ income, expense, balance }) {
  await page.locator('#monthly-income').getByText(`収入 ¥${income}`, { exact: true }).waitFor();
  await page.locator('#monthly-expense').getByText(new RegExp(`^(今月の)?支出 ¥${expense}$`)).waitFor();
  await page.locator('#monthly-balance').getByText(`収支 ${balance}`, { exact: true }).waitFor();
}

try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0', { exact: false }).waitFor();
  await waitForMonth('2026年10月');
  await totals({ income: '0', expense: '0', balance: '¥0' });

  await account('Synthetic Wallet'); await account('Synthetic Bank');
  await category('Synthetic Food'); await category('Synthetic Home'); await category('Synthetic Salary', true);
  await manual('支出', 'Synthetic Expense', 1500, 'Synthetic Food', 'Synthetic Wallet');
  await manual('収入', 'Synthetic Income', 200000, 'Synthetic Salary', 'Synthetic Bank');
  await transfer(8000, 'Synthetic Bank', 'Synthetic Wallet');
  await splitReceipt();

  await page.locator('#home-tab').click();
  await waitForMonth('2026年10月');
  await totals({ income: '200,000', expense: '2,900', balance: '+¥197,100' });
  const details = page.locator('#home-summary details.monthly-category-details');
  assert.equal(await details.locator('summary').textContent(), '支出のカテゴリ内訳');
  await details.locator('summary').click();
  const foodCircle = page.locator('#home-summary svg circle[role="button"][aria-label="Synthetic Food · ¥2,400 · 82.8%"]');
  const homeCircle = page.locator('#home-summary svg circle[role="button"][aria-label="Synthetic Home · ¥500 · 17.2%"]');
  await foodCircle.waitFor(); await homeCircle.waitFor();
  const chart = await page.locator('#home-summary svg').boundingBox();
  await page.mouse.click(chart.x + chart.width * 0.85, chart.y + chart.height * 0.5);
  await page.locator('#category-selection').getByText('Synthetic Food · ¥2,400 · 82.8%', { exact: true }).waitFor();
  await page.mouse.click(chart.x + chart.width * 0.25, chart.y + chart.height * 0.25);
  await page.locator('#category-selection').getByText('Synthetic Home · ¥500 · 17.2%', { exact: true }).waitFor();
  if (process.env.PWA_MONTHLY_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_MONTHLY_SCREENSHOT_PATH, fullPage: true });
  const rows = page.locator('#transactions > li');
  assert.equal(await rows.count(), 4);
  assert.equal(await page.getByRole('button', { name: /振替 ¥8,000/ }).count(), 1);

  await click('前月へ'); await waitForMonth('2026年9月');
  await totals({ income: '0', expense: '0', balance: '¥0' });
  await page.getByText('まだ記録がありません。', { exact: true }).waitFor();
  await click('翌月へ'); await waitForMonth('2026年10月');
  await click('翌月へ'); await waitForMonth('2026年11月');
  await totals({ income: '0', expense: '0', balance: '¥0' });
  await click('当月へ戻る'); await waitForMonth('2026年10月');
  await page.reload();
  await page.getByText('今月の支出 ¥2,900', { exact: false }).waitFor();
  await waitForMonth('2026年10月');
  await totals({ income: '200,000', expense: '2,900', balance: '+¥197,100' });
  await context.setOffline(true);
  await click('前月へ'); await waitForMonth('2026年9月');
  await totals({ income: '0', expense: '0', balance: '¥0' });
  await click('当月へ戻る'); await waitForMonth('2026年10月');
  await totals({ income: '200,000', expense: '2,900', balance: '+¥197,100' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await context.setOffline(false);
  assert.deepEqual(errors, []);
  console.log('PASS: monthly totals, transfer exclusion, split categories and percentages, month navigation, reload, offline use, and mobile width');
} catch (error) {
  console.log(await page.locator('body').innerText());
  throw error;
} finally { await browser.close(); }
