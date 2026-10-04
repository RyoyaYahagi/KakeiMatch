import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated test preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-04T03:00:00Z'));
const errors = []; page.on('pageerror', error => errors.push(error.message));
await context.route('**/api/ai/token', route => route.fulfill({ json: { token: 'synthetic-token', expiresAt: 9999999999 } }));
// The second read is a receipt paid entirely with points.
const paidWithPoints = {
  documentKind: 'receipt', merchant: 'Synthetic Points Market', purchasedDate: '2026-10-04', purchasedTime: null, totalAmountYen: 0, taxAmountYen: null,
  items: [{ name: 'Synthetic Bread', amountYen: 300 }, { name: 'Synthetic Soap', amountYen: 200 }],
  adjustments: [{ label: 'ポイント利用', amountYen: -500 }], warnings: [],
};
let reads = 0;
await context.route('**/api/ai/gemini', route => route.fulfill({ json: reads++ > 0 ? paidWithPoints : {
  documentKind: 'receipt', merchant: 'Synthetic Net Market', purchasedDate: '2026-10-04', purchasedTime: null, totalAmountYen: 750, taxAmountYen: null,
  items: [{ name: 'Synthetic Rice', amountYen: 400 }, { name: 'Synthetic Lettuce', amountYen: 150 }, { name: 'Synthetic Chicken', amountYen: 600 }],
  adjustments: [{ label: 'Synthetic Coupon', amountYen: -100 }, { label: 'ポイント利用', amountYen: -300 }],
  warnings: [
    { field: 'items', code: 'price', message: '単価と金額が異なるため確認してください。', index: 1 },
    { field: 'totalAmountYen', code: 'blurred', message: '合計金額の数字がかすれています。', index: null },
    { field: null, code: 'layout', message: 'Unusual document layout' },
  ],
} }));
await context.route('**/api/ai/jev', route => route.fulfill({ status: 503, json: { error: 'provider_unavailable' } }));
const click = name => page.getByRole('button', { name, exact: true }).click();
try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0').waitFor();
  await page.locator('#settings-tab').click(); await click('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Wallet'); await click('追加する');
  await page.getByRole('button', { name: 'Synthetic Wallet · 利用中', exact: true }).waitFor();
  await page.locator('#settings-tab').click(); await click('カテゴリ'); await click('基本カテゴリを用意する');
  await page.getByText('基本カテゴリを用意しました。', { exact: true }).waitFor();
  await page.locator('#receipt-tab').click();
  await click('記録を追加');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64') });
  await click('AIで読み取る');
  const band = page.getByRole('region', { name: '画像と照らし合わせてほしいところが3件あります' });
  await band.waitFor();
  const rows = band.locator('.receipt-review-row');
  assert.equal(await rows.count(), 3);
  assert.match(await rows.nth(0).textContent(), /品目2「Synthetic Lettuce」.*単価と金額が異なるため確認してください。/);
  assert.match(await rows.nth(1).textContent(), /合計金額.*合計金額の数字がかすれています。/);
  // A message that is not Japanese is replaced with a plain instruction.
  assert.match(await rows.nth(2).textContent(), /レシート全体.*画像の内容と照らし合わせてください。/);
  // The place is marked with words, not only color.
  assert.equal(await page.locator('#receipt-amount-review').textContent(), '△ 要確認');
  assert.equal(await page.locator('#receipt-amount').getAttribute('aria-describedby'), 'receipt-amount-review');
  assert.match(await page.locator('[data-receipt-item]').nth(1).locator('.receipt-compact-meta').textContent(), /^△ 要確認 · /);
  assert.doesNotMatch(await page.locator('[data-receipt-item]').nth(0).locator('.receipt-compact-meta').textContent(), /要確認/);
  if (process.env.PWA_RECEIPT_AI_WARNINGS_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RECEIPT_AI_WARNINGS_SCREENSHOT_PATH });
  // Each row moves to the place it is about.
  await rows.nth(0).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-receipt-item]')[1]?.open === true);
  assert.equal(await page.locator('[data-receipt-item]').nth(1).locator('[data-item-name]').evaluate(node => node === document.activeElement), true);
  await page.getByRole('button', { name: '全体', exact: true }).click();
  await rows.nth(1).click();
  await page.waitForFunction(() => document.activeElement?.id === 'receipt-amount');
  // Points are an adjustment like a coupon: the total is the amount paid after points, with no memo added.
  assert.equal(await page.locator('#receipt-amount').inputValue(), '750');
  assert.equal(await page.locator('#receipt-memo').inputValue(), '');
  // A checked row disappears, and editing a flagged field counts as checking it.
  await click('レシート全体を確認した');
  await page.getByRole('region', { name: '画像と照らし合わせてほしいところが2件あります' }).waitFor();
  await page.locator('#receipt-amount').fill('1060');
  await page.getByRole('region', { name: '画像と照らし合わせてほしいところが1件あります' }).waitFor();
  assert.equal(await page.locator('#receipt-amount-review').count(), 0);
  assert.equal(await page.locator('#receipt-amount').getAttribute('aria-describedby'), null);
  // Checked warnings stay hidden when the receipt is opened again.
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: 'Synthetic Net Market · 確認する', exact: true }).click();
  const remaining = page.getByRole('region', { name: '画像と照らし合わせてほしいところが1件あります' });
  await remaining.waitFor();
  assert.match(await remaining.locator('.receipt-review-row').textContent(), /品目2「Synthetic Lettuce」/);
  await click('品目2「Synthetic Lettuce」を確認した');
  await remaining.waitFor({ state: 'detached' });
  assert.doesNotMatch(await page.locator('[data-receipt-item]').nth(1).locator('.receipt-compact-meta').textContent(), /要確認/);
  // The receipt registers with the total after coupons and points.
  await page.getByRole('button', { name: '全体', exact: true }).click();
  await page.locator('#receipt-amount').fill('750');
  await page.locator('#receipt-category').selectOption({ label: '食費' });
  await page.locator('#receipt-account').selectOption({ label: 'Synthetic Wallet' });
  await click('登録する');
  await page.waitForFunction(() => document.querySelector('#message')?.textContent === '登録しました。' || [...document.querySelectorAll('button')].some(button => button.textContent === '登録を再試行する'));
  assert.equal(await page.locator('#message').textContent(), '登録しました。');
  // A receipt paid entirely with points keeps a 0 yen total and can be registered as it is.
  await click('記録を追加');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64') });
  await click('AIで読み取る');
  await page.waitForFunction(() => document.querySelector('#receipt-merchant')?.value === 'Synthetic Points Market');
  assert.equal(await page.locator('#receipt-amount').inputValue(), '0');
  await page.locator('#receipt-category').selectOption({ label: '食費' });
  await page.locator('#receipt-account').selectOption({ label: 'Synthetic Wallet' });
  await click('登録する');
  await page.waitForFunction(() => document.querySelector('#message')?.textContent === '登録しました。' || [...document.querySelectorAll('button')].some(button => button.textContent === '登録を再試行する'));
  assert.equal(await page.locator('#message').textContent(), '登録しました。');
  // The 0 yen row is listed as an expense in its category, not as income.
  const zeroRow = page.getByRole('button', { name: /^Synthetic Points Market · / });
  await zeroRow.waitFor();
  assert.match(await zeroRow.getAttribute('aria-label'), /食費/);
  assert.doesNotMatch(await zeroRow.getAttribute('aria-label'), /収入/);
  assert.deepEqual(errors, []);
  console.log('PASS: read warnings name the place and reason, mark fields with words, replace non-Japanese messages, move to each place, hide checked or edited ones across reopening, and register totals after points like a coupon, including a 0 yen receipt paid entirely with points.');
} finally {
  await browser.close();
}
