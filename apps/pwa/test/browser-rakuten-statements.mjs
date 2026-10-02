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

const header = ['利用日', '利用店名・商品名', '利用者', '支払方法', '利用金額', '手数料/利息', '支払総額', '9月支払金額', '当月請求額', '10月繰越残高', '新規サイン'];
const normal = ['2026/09/28', 'Synthetic Market', '本人', '1回払い', '1200', '0', '1200', '1200', '1100', '0', ''];
const installment = ['2026/09/29', 'Synthetic Installment', '本人', '分割払い', '9000', '0', '9000', '3000', '3000', '0', ''];
const pairParent = ['2026/09/30', 'Synthetic Pair Parent', '本人', '1回払い', '500', '0', '500', '500', '500', '0', ''];
const continuation = ['', 'Synthetic Item Continuation', '', '', '', '', '', '', '', '', ''];
const csv = `\uFEFF${[header, normal, installment, pairParent, continuation].map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n')}\r\n`;
const bytes = Buffer.from(csv, 'utf8');

try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0').waitFor();
  const upload = async () => {
    await page.locator('#settings-tab').click();
    await page.locator('#statement-tab').click();
    await page.locator('#statement-provider').selectOption('rakuten_card');
    await page.locator('#statement-file').setInputFiles({ name: 'synthetic-rakuten.csv', mimeType: 'text/csv', buffer: bytes });
    await page.getByRole('button', { name: '明細を取り込む', exact: true }).click();
  };

  await upload();
  await page.getByText(/1件を取り込みました。重複 0件。対象外 0件、要確認 3件。/).waitFor();
  await page.getByText('楽天カード: 要確認 3件', { exact: true }).waitFor();
  await page.getByText('4行目: 複数行明細の可能性があるため確認してください', { exact: true }).waitFor();
  await page.getByText('5行目: 継続行または部分行の可能性があります', { exact: true }).waitFor();
  assert.equal(await page.getByText('Synthetic Pair Parent', { exact: false }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.PWA_RAKUTEN_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RAKUTEN_SCREENSHOT_PATH, fullPage: true });

  await upload();
  await page.getByText(/0件を取り込みました。重複 1件。対象外 0件、要確認 3件。/).waitFor();
  await page.locator('#reconciliation-tab').click();
  await page.getByRole('button', { name: '照合を更新する', exact: true }).click();
  await page.getByText(/記録なし 1件/).waitFor();
  await page.locator('#local-view summary').filter({ hasText: 'Synthetic Market' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: Rakuten UTF-8 BOM import, strict one-time purchase, review rows, continuation safety, duplicate reimport, and reconciliation at 375px.');
} catch (error) {
  console.log(await page.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
}
