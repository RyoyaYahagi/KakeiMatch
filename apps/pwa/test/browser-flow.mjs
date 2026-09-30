import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a dedicated preview or local PWA.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addInitScript(() => {
  if (!sessionStorage.getItem('synthetic-enable-offline')) {
    window.syntheticRegisterOffline = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = async () => ({});
  }
});
const page = await context.newPage();
const errors = [];
page.on('console', message => { if (message.type() === 'error') console.log('Browser error', message.text()); });
page.on('requestfailed', request => console.log('Failed request', new URL(request.url()).pathname, request.failure()?.errorText));
page.on('request', request => { if (request.url().includes('/api/ai/')) console.log('AI test request', new URL(request.url()).pathname); });
page.on('response', response => { if (response.url().includes('/api/ai/')) console.log('AI test response', new URL(response.url()).pathname, response.status()); });
page.on('pageerror', error => errors.push(error.message));
const aiRequests = [];
await context.route('**/api/ai/token', route => route.fulfill({ json: { token: 'synthetic-token', expiresAt: Math.floor(Date.now() / 1000) + 600 } }));
await context.route('**/api/ai/gemini', async route => {
  aiRequests.push(JSON.parse(route.request().postData()));
  await route.fulfill({ json: { documentKind: 'receipt', merchant: 'Diagnostic Store', purchasedDate: '2026-09-30', purchasedTime: '12:00', totalAmountYen: 1280, taxAmountYen: null, items: [], warnings: [] } });
});
try {
  await page.goto(url);
  await page.getByText('今月の支出 ¥0').waitFor();
  await page.locator('#settings-tab').click();
  page.once('dialog', dialog => dialog.accept('Synthetic Wallet'));
  await page.getByRole('button', { name: '支払元を追加する', exact: true }).click();
  await page.getByText('支払元を追加しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '基本カテゴリを用意する', exact: true }).click();
  await page.getByText('基本カテゴリを用意しました。', { exact: true }).waitFor();
  await page.locator('#receipt-tab').click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64');
  await page.locator('#local-view input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'AIで読み取る', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#receipt-merchant')?.value === 'Diagnostic Store', null, { timeout: 10000 });
  await page.locator('#receipt-merchant').fill('Diagnostic Store corrected');
  await page.locator('#receipt-category').selectOption({ label: '食費' });
  await page.getByRole('button', { name: '確認して家計簿へ登録する', exact: true }).click();
  await page.getByText('家計簿へ登録済みです。', { exact: true }).waitFor({ timeout: 10000 });
  assert.deepEqual(Object.keys(aiRequests[0]).sort(), ['contentType', 'imageBase64']);
  await page.reload();
  await page.getByText(/Diagnostic Store Corrected/i).first().waitFor();
  const headers = '取引日,出金金額（円）,入金金額（円）,海外出金金額,通貨,変換レート（円）,利用国,取引内容,取引先,取引方法,支払い区分,利用者,取引番号';
  const csv = `${headers}\n2026/09/30 12:00,1280,0,,,,,支払い,Diagnostic Store corrected,PayPay,,,synthetic-match\n2026/09/30 13:00,500,0,,,,,支払い,Synthetic New Store,PayPay,,,synthetic-unmatched\n`;
  const upload = async () => {
    await page.locator('#statement-tab').click();
    await page.locator('#statement-file').setInputFiles({ name: 'synthetic-paypay.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByRole('button', { name: '明細を取り込む', exact: true }).click();
  };
  await upload();
  await page.getByText('2件を取り込みました。重複 0件。', { exact: true }).waitFor();
  await upload();
  await page.getByText('0件を取り込みました。重複 2件。', { exact: true }).waitFor();
  await page.locator('#reconciliation-tab').click();
  await page.getByRole('button', { name: '照合を更新する', exact: true }).click();
  await page.getByText(/自動確認済み 1件/).waitFor();
  await page.locator('summary').filter({ hasText: 'Synthetic New Store' }).click();
  await page.locator('details select').first().selectOption({ label: 'Synthetic Wallet' });
  await page.locator('details select').last().selectOption({ label: '日用品' });
  await page.getByRole('button', { name: '自分の利用・レシートなし', exact: true }).click();
  await page.getByText(/記録なし 0件/).waitFor();
  await page.locator('#home-tab').click();
  await page.getByText('今月の支出 ¥1,780', { exact: false }).waitFor();
  await page.evaluate(async () => {
    sessionStorage.setItem('synthetic-enable-offline', 'true');
    await window.syntheticRegisterOffline('/sw.js');
    await navigator.serviceWorker.ready;
    // An active registration alone does not guarantee that this page is controlled.
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
  await page.reload();
  await page.getByText('今月の支出 ¥1,780', { exact: false }).waitFor();
  await context.setOffline(true);
  await page.reload();
  await page.getByText('オフライン', { exact: true }).waitFor();
  await page.getByText('今月の支出 ¥1,780', { exact: false }).waitFor();
  await page.locator('#reconciliation-tab').click();
  await page.getByRole('button', { name: '照合を更新する', exact: true }).click();
  await page.getByText(/要確認 0件/).waitFor();
  await upload();
  await page.getByText('0件を取り込みました。重複 2件。', { exact: true }).waitFor();
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: '手入力する', exact: true }).click();
  await page.locator('#receipt-merchant').fill('Synthetic Offline Store');
  await page.locator('#receipt-amount').fill('200');
  await page.locator('#receipt-category').selectOption({ label: '食費' });
  await page.getByRole('button', { name: '確認して家計簿へ登録する', exact: true }).click();
  await page.getByText('家計簿へ登録済みです。', { exact: true }).waitFor({ timeout: 10000 });
  await page.locator('#home-tab').click();
  await page.getByText('今月の支出 ¥1,980', { exact: false }).waitFor();
  if (process.env.PWA_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_SCREENSHOT_PATH, fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: real browser ledger, mocked AI, receipt correction, stable reload, PayPay duplicates, automatic reconciliation, no-receipt review, offline reload/write.');
} catch (error) { console.error(await page.locator('body').innerText()); console.error('Page errors:', errors); throw error; } finally { await browser.close(); }
