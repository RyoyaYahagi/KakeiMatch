import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to a dedicated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-01T03:00:00Z'));
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();

const headers = '利用日,利用店名・商品名,利用者,支払方法,利用金額,手数料/利息,支払総額,9月支払金額,当月請求額,10月繰越残高,新規サイン';
const csv = `${headers}\n2026/10/01,Synthetic Unrecorded Market,本人,1回払い,1200,0,1200,1200,1200,0,\n`;

try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await page.locator('#settings-tab').click();
  await click('カテゴリ'); await click('基本カテゴリを用意する'); await page.getByText('基本カテゴリを用意しました。', { exact: true }).waitFor();
  await click('設定へ戻る');

  // No payment source exists: choosing the statement service and CSV is enough to reach results.
  await page.locator('#reconciliation-tab').click();
  const importer = page.locator('summary').filter({ hasText: '明細CSVを取り込む' }); if (await importer.count()) await importer.click();
  assert.equal(await page.locator('#statement-account').count(), 0);
  await page.locator('#statement-provider').selectOption('rakuten_card');
  await page.locator('#statement-file').setInputFiles({ name: 'synthetic-provider-only-rakuten.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await click('取り込んで照合');
  await page.getByText('1件を取り込み、照合しました。重複 0件。対象外 0件、要確認 0件。', { exact: true }).waitFor();
  await page.getByText(/要確認 0件 · 記録なし 1件 · 明細待ち 0件/).waitFor();
  assert.equal(await page.getByText(/照合できる支払元がありません/).count(), 0);

  const unrecorded = page.locator('#local-view details').filter({ hasText: 'Synthetic Unrecorded Market' });
  await unrecorded.locator('summary').click();
  await unrecorded.getByText('支払元がありません。登録するには支払元を追加してください。', { exact: true }).waitFor();
  await unrecorded.locator('select[id^="category-"]').selectOption({ label: '食費' });
  await unrecorded.getByRole('button', { name: '支払元・口座を追加', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Inline Card');
  await dialog.locator('select[name="accountType"]').selectOption('credit_card');
  await dialog.getByRole('button', { name: '追加する', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await unrecorded.locator('select[id^="account-"]').locator('option:checked').textContent(), 'Synthetic Inline Card');
  await unrecorded.getByRole('button', { name: '支出として登録', exact: true }).click();
  await page.getByText(/要確認 0件 · 記録なし 0件/).waitFor();

  // Re-importing the same CSV does not create a second statement row.
  const again = page.locator('summary').filter({ hasText: '明細CSVを取り込む' }); if (await again.count()) await again.click();
  await page.locator('#statement-provider').selectOption('rakuten_card');
  await page.locator('#statement-file').setInputFiles({ name: 'synthetic-provider-only-rakuten.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await click('取り込んで照合');
  await page.getByText('0件を取り込み、照合しました。重複 1件。対象外 0件、要確認 0件。', { exact: true }).waitFor();
  await page.getByText(/要確認 0件 · 記録なし 0件/).waitFor();

  await page.locator('#home-tab').click();
  await page.getByText('今月の支出 ¥1,200').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: zero payment sources → provider + CSV import → reconciliation results, and a payment source is asked only when registering an unrecorded statement at 375px.');
} catch (error) {
  console.log(await page.locator('body').innerText()); throw error;
} finally { await browser.close(); }
