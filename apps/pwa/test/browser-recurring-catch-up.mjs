import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Tokyo' });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-04T03:00:00.000Z'));
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => {
  assert.equal(dialog.type(), 'confirm');
  void dialog.accept();
});
const click = name => page.getByRole('button', { name, exact: true }).click();

async function settings(name) { await page.locator('#settings-tab').click(); await click(name); }
async function addAccount(name) {
  await settings('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: `${name} · 利用中`, exact: true }).waitFor();
}
async function addCategory(name) {
  await settings('カテゴリ'); await click('カテゴリを追加する');
  await page.getByLabel('カテゴリ名', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).waitFor();
}
async function recurringList() {
  await settings('定期登録');
  await page.getByRole('heading', { name: '定期登録', exact: true }).waitFor();
}
async function openCreate() {
  await recurringList(); await click('定期登録を追加する'); await page.locator('#recurring-name').waitFor();
}
async function fillSchedule({ name, startDate, frequency = 'monthly' }) {
  await page.locator('#recurring-name').fill(name);
  await page.locator('#recurring-kind').selectOption('expense');
  await page.locator('#recurring-amount').fill('1700');
  await page.locator('#recurring-category').selectOption({ label: 'Synthetic Catch-up Food' });
  await page.locator('#recurring-account').selectOption({ label: 'Synthetic Catch-up Wallet' });
  await page.locator('#recurring-frequency').selectOption(frequency);
  await page.locator('#recurring-start-date').fill(startDate);
  await page.locator('#recurring-auto').setChecked(false);
}
async function addMatchingManualTransaction(name) {
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('支出を手入力');
  await page.locator('#manual-transaction-payee').waitFor();
  await page.locator('#manual-transaction-payee').fill(name);
  await page.locator('#manual-transaction-amount').fill('1700');
  await page.locator('#manual-transaction-date').fill('2026-10-01');
  await page.locator('#manual-transaction-category').selectOption({ label: 'Synthetic Catch-up Food' });
  await page.locator('#manual-transaction-account').selectOption({ label: 'Synthetic Catch-up Wallet' });
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}
async function submitSchedule() { await click('保存する'); }
async function historyDetail(name) {
  await recurringList();
  await page.getByRole('button', { name: new RegExp(`^${name} · 支出`) }).click();
  await page.locator('section.recurring-catch-up-history').waitFor();
  await page.locator('section.recurring-catch-up-history [data-catch-up-operation-id]').first().waitFor();
}
async function recordNames() {
  await page.locator('#receipt-tab').click();
  await page.locator('.record-groups').waitFor();
  await page.locator('.record-groups .record-row').first().waitFor();
  return page.locator('.record-groups').innerText();
}
function occurrencesOf(text, value) { return text.toLowerCase().split(value.toLowerCase()).length - 1; }
async function chooseCatchUp(action) {
  await page.locator(`[data-catch-up-${action}]`).click();
}

try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0').waitFor();
  await addAccount('Synthetic Catch-up Wallet');
  await addCategory('Synthetic Catch-up Food');
  await addMatchingManualTransaction('Synthetic Catch-up Monthly');

  // One past occurrence is created directly; its later Undo must not remove another schedule's transaction.
  await openCreate();
  await fillSchedule({ name: 'Synthetic Catch-up Single', startDate: '2026-10-03' });
  await submitSchedule();
  await page.getByRole('button', { name: 'Synthetic Catch-up Single · 支出 ¥1,700', exact: true }).waitFor();
  let names = await recordNames();
  assert.equal(occurrencesOf(names, 'Synthetic Catch-up Single'), 1);

  // A yearly rule with no due date this month can retain its past start without old records.
  await openCreate();
  await fillSchedule({ name: 'Synthetic Catch-up Yearly Future', startDate: '2024-01-01', frequency: 'yearly' });
  await submitSchedule();
  await page.locator('[data-catch-up-current-month]').waitFor();
  assert.equal(await page.locator('[data-catch-up-current-month]').isEnabled(), true);
  await chooseCatchUp('current-month');
  await page.getByRole('button', { name: 'Synthetic Catch-up Yearly Future · 支出 ¥1,700', exact: true }).waitFor();
  names = await recordNames();
  assert.equal(occurrencesOf(names, 'Synthetic Catch-up Yearly Future'), 0);
  await recurringList();
  await click('Synthetic Catch-up Yearly Future · 支出 ¥1,700');
  assert.match(await page.locator('.recurring-detail').innerText(), /2024-01-01/);

  // The immediate action removes just this new batch; saving again keeps the date claimed.
  await openCreate();
  await fillSchedule({ name: 'Synthetic Catch-up Immediate', startDate: '2026-10-02' });
  await submitSchedule();
  await page.locator('[data-catch-up-immediate-undo]').waitFor();
  assert.match(await page.locator('[data-catch-up-result]').innerText(), /1件/);
  await page.locator('[data-catch-up-immediate-undo]').click();
  await page.getByText('今回の過去分を取り消しました。', { exact: true }).waitFor();
  names = await recordNames();
  assert.equal(occurrencesOf(names, 'Synthetic Catch-up Immediate'), 0);
  assert.equal(occurrencesOf(names, 'Synthetic Catch-up Single'), 1);

  // Cancel a multi-date preview before Actual is changed, then choose only the current-month occurrence.
  await openCreate();
  await fillSchedule({ name: 'Synthetic Catch-up Monthly', startDate: '2026-07-01' });
  await submitSchedule();
  const previewText = await page.locator('[data-catch-up-all]').locator('xpath=..').innerText();
  assert.match(previewText, /4件/);
  assert.match(previewText, /6,800/);
  if (process.env.PWA_CATCH_UP_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.PWA_CATCH_UP_SCREENSHOT_DIR}/issue192-confirm-375.png` });
  await chooseCatchUp('cancel');
  if (await page.locator('#recurring-name').count()) await click('一覧へ戻る');
  await recurringList();
  assert.equal(await page.getByRole('button', { name: 'Synthetic Catch-up Monthly · 支出 ¥1,700', exact: true }).count(), 0);

  await openCreate();
  await fillSchedule({ name: 'Synthetic Catch-up Monthly', startDate: '2026-07-01' });
  await submitSchedule();
  await chooseCatchUp('current-month');
  await page.getByRole('button', { name: 'Synthetic Catch-up Monthly · 支出 ¥1,700', exact: true }).waitFor();
  await historyDetail('Synthetic Catch-up Monthly');
  const monthlyHistory = page.locator('section.recurring-catch-up-history');
  assert.equal(await monthlyHistory.locator('[data-catch-up-operation-id]').count(), 1);
  assert.equal(await monthlyHistory.locator('[data-catch-up-date]').count(), 1);
  assert.equal(await monthlyHistory.locator('[data-catch-up-date]').first().getAttribute('value'), '2026-10-01');
  await recordNames();
  assert.equal(await page.locator('.record-row[data-date="2026-10-01"]').filter({ hasText: 'Synthetic Catch-up Monthly' }).count(), 2,
    'an identical same-day manual transaction and catch-up transaction should coexist');

  // Reopen the same schedule and catch up the remaining older occurrences with the all-dates choice.
  await recurringList();
  await page.getByRole('button', { name: 'Synthetic Catch-up Monthly · 支出 ¥1,700', exact: true }).click();
  await click('編集する');
  await submitSchedule();
  const remainingPreview = await page.locator('[data-catch-up-all]').locator('xpath=..').innerText();
  assert.match(remainingPreview, /3件/);
  assert.match(remainingPreview, /5,100/);
  await chooseCatchUp('all');
  await page.locator('[data-catch-up-result]').waitFor();
  await historyDetail('Synthetic Catch-up Monthly');
  assert.equal(await page.locator('section.recurring-catch-up-history [data-catch-up-operation-id]').count(), 2);
  assert.equal(await page.locator('section.recurring-catch-up-history [data-catch-up-date]').count(), 4);
  if (process.env.PWA_CATCH_UP_SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 375, height: 1600 });
    await page.screenshot({ path: `${process.env.PWA_CATCH_UP_SCREENSHOT_DIR}/issue192-history-375.png` });
    await page.setViewportSize({ width: 375, height: 812 });
  }

  // Add another same-day schedule so later Undo proves it is isolated by transaction identity.
  await openCreate();
  await fillSchedule({ name: 'Synthetic Catch-up Other', startDate: '2026-10-01' });
  await submitSchedule();
  await page.getByRole('button', { name: 'Synthetic Catch-up Other · 支出 ¥1,700', exact: true }).waitFor();
  await historyDetail('Synthetic Catch-up Monthly');
  const julyOccurrence = page.locator('section.recurring-catch-up-history [data-catch-up-date][value="2026-07-01"]');
  await julyOccurrence.check();
  await page.locator('[data-catch-up-operation-id]').filter({ has: page.locator('[data-catch-up-date][value="2026-07-01"]') }).locator('[data-catch-up-delete-selected]').click();
  await page.getByText('2026-07-01 · ¥1,700 · 削除済み', { exact: true }).waitFor();
  names = await recordNames();
  assert.equal(occurrencesOf(names, 'Synthetic Catch-up Monthly'), 4);
  assert.equal(occurrencesOf(names, 'Synthetic Catch-up Other'), 1);

  // Editing one generated transaction makes Undo retain it while deleting the untouched dates.
  await recordNames();
  await page.locator('.record-row[data-date="2026-08-01"]').filter({ hasText: 'Synthetic Catch-up Monthly' }).click();
  await page.getByRole('heading', { name: '支出の記録', exact: true }).waitFor();
  await page.getByRole('button', { name: /^金額を編集:/ }).click();
  await page.locator('#manual-transaction-amount').fill('1800');
  await click('変更を保存する');
  await page.getByText('変更を保存しました。', { exact: true }).waitFor();
  await page.locator('#settings-tab').click();
  await historyDetail('Synthetic Catch-up Monthly');
  const monthlyOperations = page.locator('section.recurring-catch-up-history [data-catch-up-operation-id]');
  const olderOperation = monthlyOperations.filter({ has: page.locator('[data-catch-up-date][value="2026-09-01"]') });
  assert.equal(await olderOperation.count(), 1);
  await olderOperation.locator('[data-catch-up-undo]').click();
  await page.getByText(/編集済みのため残しました/).waitFor();
  names = await recordNames();
  assert.equal(occurrencesOf(names, 'Synthetic Catch-up Monthly'), 3);
  assert.equal(occurrencesOf(names, 'Synthetic Catch-up Other'), 1);
  assert.match(await page.locator('.record-row[data-date="2026-08-01"]').filter({ hasText: 'Synthetic Catch-up Monthly' }).innerText(), /¥1,800/);
  await recurringList();
  assert.equal(await page.getByText('前回の定期登録処理が保留中です。再試行してください。', { exact: true }).count(), 0,
    'Undo should finish without leaving a pending operation');

  // Undo the untouched current-month occurrence, preserving both the edited record and the other schedule.
  await historyDetail('Synthetic Catch-up Monthly');
  const octoberOperation = page.locator('section.recurring-catch-up-history [data-catch-up-operation-id]')
    .filter({ has: page.locator('[data-catch-up-date][value="2026-10-01"]') });
  assert.equal(await octoberOperation.count(), 1);
  await octoberOperation.locator('[data-catch-up-undo]').click();
  await recordNames();
  names = await page.locator('.record-groups').innerText();
  assert.equal(occurrencesOf(names, 'Synthetic Catch-up Monthly'), 2,
    'Undo must remove only the generated transaction and preserve the identical manual transaction');
  assert.equal(occurrencesOf(names, 'Synthetic Catch-up Other'), 1);

  // Saving the unchanged schedule again must not create already-audited dates a second time.
  await historyDetail('Synthetic Catch-up Monthly');
  await click('編集する'); await submitSchedule();
  await page.getByRole('button', { name: 'Synthetic Catch-up Monthly · 支出 ¥1,700', exact: true }).waitFor();
  names = await recordNames();
  assert.equal(occurrencesOf(names, 'Synthetic Catch-up Monthly'), 2);
  assert.equal(occurrencesOf(names, 'Synthetic Catch-up Other'), 1);

  await page.reload(); await page.getByText('今月の支出', { exact: false }).waitFor();
  await historyDetail('Synthetic Catch-up Monthly');
  assert.equal(await page.locator('section.recurring-catch-up-history [data-catch-up-operation-id]').count(), 2);
  names = await recordNames();
  assert.equal(occurrencesOf(names, 'Synthetic Catch-up Monthly'), 2);
  assert.equal(occurrencesOf(names, 'Synthetic Catch-up Other'), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log('PASS: recurring catch-up one/multiple dates, cancel/current-month/all choices, identical manual-transaction safety, selected deletion, edited-row retention on Undo, duplicate prevention, and reload persistence');
} catch (error) {
  console.log(await page.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
}
