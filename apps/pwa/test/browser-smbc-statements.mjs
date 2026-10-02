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
const cp932 = text => Buffer.concat(text.split(/(１)/).map(part => part === '１' ? Buffer.from([0x82, 0x50]) : Buffer.from(part, 'ascii')));
const csv = [
  'SYNTHETIC MEMBER,SYNTHETIC CARD,SYNTHETIC STATEMENT',
  '2026/09/28,Synthetic Market,1200,１,１,1200,',
  '2026/09/29,Synthetic Installment,9000,installment,2,3000,',
  ',,,,,9000,',
].join('\r\n') + '\r\n';
try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0').waitFor();
  const upload = async () => {
    await page.locator('#settings-tab').click();
    await page.locator('#statement-tab').click();
    await page.locator('#statement-provider').selectOption('smbc_card');
    await page.locator('#statement-file').setInputFiles({ name: 'synthetic-vpass.csv', mimeType: 'text/csv', buffer: cp932(csv) });
    await page.getByRole('button', { name: '明細を取り込む', exact: true }).click();
  };
  await upload();
  await page.getByText('1件を取り込みました。重複 0件。対象外 0件、要確認 1件。3行目: 1回払い以外の可能性があります', { exact: true }).waitFor();
  await page.getByText('三井住友カード: 要確認 1件', { exact: true }).waitFor();
  await page.getByText('3行目: 1回払い以外の可能性があります', { exact: true }).waitFor();
  assert.equal(await page.getByText('SYNTHETIC MEMBER', { exact: false }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.PWA_SMBC_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_SMBC_SCREENSHOT_PATH, fullPage: true });

  await upload();
  await page.getByText('0件を取り込みました。重複 1件。対象外 0件、要確認 1件。3行目: 1回払い以外の可能性があります', { exact: true }).waitFor();
  await page.locator('#reconciliation-tab').click();
  await page.getByRole('button', { name: '照合を更新する', exact: true }).click();
  await page.getByText(/記録なし 1件/).waitFor();
  await page.locator('#local-view summary').filter({ hasText: 'Synthetic Market' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: SMBC Vpass CP932 import, unsupported row review persistence, duplicate reimport, and reconciliation at 375px.');
} catch (error) {
  console.log(await page.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
}
