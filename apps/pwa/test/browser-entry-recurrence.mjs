import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// docs/UX.md 支出の入力: "くり返し" on a new expense or income also creates a schedule that starts at the next occurrence.
if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Tokyo' });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage();
// Actual runs schedules in its Worker on the real clock, so the entry uses the real Tokyo day.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
const [year, month, day] = today.split('-').map(Number);
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
async function entry(kind, name, amount, category, account, recurrence) {
  await page.locator('#home-tab').click(); await click('記録を追加');
  await page.locator('#record-sheet').getByRole('button', { name: kind, exact: true }).click();
  await page.locator('#manual-transaction-amount').waitFor();
  await page.locator('#manual-transaction-payee').fill(name);
  await page.locator('#manual-transaction-amount').fill(String(amount));
  await page.locator('#manual-transaction-date').fill(today);
  await page.locator('#manual-transaction-category').selectOption({ label: category });
  await page.locator('#manual-transaction-account').selectOption({ label: account });
  await page.getByLabel('くり返し', { exact: true }).selectOption({ label: recurrence });
}
const nextMonth = (() => {
  // The schedule skips months without this day, like the schedule screen.
  for (let offset = 1; offset < 13; offset++) {
    const candidate = new Date(Date.UTC(year, month - 1 + offset, day));
    if (candidate.getUTCDate() === day) return candidate.toISOString().slice(0, 10);
  }
  throw new Error('no next month');
})();
const nextWeek = new Date(Date.UTC(year, month - 1, day + 7)).toISOString().slice(0, 10);
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await addAccount('Synthetic Repeat Wallet');
  await addCategory('Synthetic Repeat Rent'); await addCategory('Synthetic Repeat Salary', true);

  // The row is off by default and says what it will do once chosen.
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('支出を手入力');
  assert.equal(await page.getByLabel('くり返し', { exact: true }).inputValue(), '');
  await click('キャンセル'); await page.keyboard.press('Escape');

  await entry('支出を手入力', 'Synthetic Repeat Rent Payment', 80000, 'Synthetic Repeat Rent', 'Synthetic Repeat Wallet', '毎月');
  await page.getByText('定期登録も作ります', { exact: true }).waitFor();
  await click('登録する');
  await page.getByText(`登録しました。${nextMonth}から定期登録も作りました。`, { exact: true }).waitFor();

  await entry('収入', 'Synthetic Repeat Pay', 3000, 'Synthetic Repeat Salary', 'Synthetic Repeat Wallet', '毎週');
  await click('登録する');
  await page.getByText(`登録しました。${nextWeek}から定期登録も作りました。`, { exact: true }).waitFor();

  // A second schedule with the same name is refused before the record is saved.
  await entry('支出を手入力', 'Synthetic Repeat Rent Payment', 80000, 'Synthetic Repeat Rent', 'Synthetic Repeat Wallet', '毎月');
  await click('登録する');
  await page.getByText('同じ名前の定期登録があります。店名を変えるか、「くり返し」を「しない」にしてください。', { exact: true }).waitFor();
  await click('キャンセル'); await page.keyboard.press('Escape');
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: /^Synthetic Repeat Pay ·/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Synthetic Repeat Rent Payment ·/ }).count(), 1);

  await settings('定期登録'); await page.getByRole('heading', { name: '定期登録', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Synthetic Repeat Rent Payment · 支出 ¥80,000', exact: true }).click();
  await page.getByText(nextMonth, { exact: true }).first().waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: "くり返し" on a new expense and income creates schedules from the next occurrence, and a duplicate name is refused before saving');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; } finally { await browser.close(); }
