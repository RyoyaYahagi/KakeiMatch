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
// Keep monthly totals aligned with the synthetic receipts, regardless of the run date.
await page.clock.setFixedTime(new Date('2026-09-30T03:00:00Z'));
const errors = [];
page.on('console', message => { if (message.type() === 'error') console.log('Browser error', message.text()); });
page.on('requestfailed', request => console.log('Failed request', new URL(request.url()).pathname, request.failure()?.errorText));
page.on('request', request => { if (request.url().includes('/api/ai/')) console.log('AI test request', new URL(request.url()).pathname); });
page.on('response', response => { if (response.status() >= 400) console.log('HTTP test response', new URL(response.url()).pathname, response.status()); if (response.url().includes('/api/ai/')) console.log('AI test response', new URL(response.url()).pathname, response.status()); });
page.on('pageerror', error => errors.push(error.message));
const aiRequests = [];
const categoryRequests = [];
const usedFlows = new Set();
let quotaExceeded = false;
await context.route('**/api/auth/get-session', route => route.fulfill({ json: { user: { id: 'synthetic-user', name: 'Synthetic User' }, session: { id: 'synthetic-session', expiresAt: '2099-01-01T00:00:00Z' } } }));
await context.route('**/api/auth/passkey/list-user-passkeys', route => route.fulfill({ json: [] }));
await context.route('**/api/ai/usage', route => route.fulfill({ json: { plan: 'free', month: '2026-09', used: usedFlows.size, limit: 30, remaining: 30 - usedFlows.size } }));
await context.route('**/api/ai/jev', async route => {
  const body = route.request().postDataJSON();
  categoryRequests.push(body);
  assert.ok(usedFlows.has(body.flowId));
  const categories = body.categories;
  const food = categories.find(category => category.name === '食費');
  assert.ok(food, 'The Jev request should include the native food category.');
  const probabilities = Object.fromEntries(categories.map(category => [category.id, category.id === food.id ? 1 : 0]));
  await route.fulfill({ json: { model: 'synthetic-model', answers: { category: { type: 'choice', choice: food.id, confidence: 1, probabilities } } } });
});
await context.route('**/api/ai/token', route => route.fulfill({ json: { token: 'synthetic-token', expiresAt: Math.floor(Date.now() / 1000) + 600 } }));
await context.route('**/api/ai/gemini', async route => {
  const body = route.request().postDataJSON();
  aiRequests.push(body);
  assert.match(body.flowId, /^[a-f0-9-]{36}$/);
  if (quotaExceeded) { await route.fulfill({ status: 429, json: { error: 'ai_quota_exceeded' } }); return; }
  usedFlows.add(body.flowId);
  await route.fulfill({ json: { documentKind: 'receipt', merchant: 'Diagnostic Store', purchasedDate: '2026-09-30', purchasedTime: '12:00', totalAmountYen: 1280, taxAmountYen: null, items: [], warnings: [] } });
});
try {
  await page.goto(url);
  await page.getByText('今月の支出 ¥0').waitFor();
  await page.locator('#settings-tab').click();
  await page.getByRole('button', { name: '支払元', exact: true }).click();
  await page.getByRole('button', { name: '支払元を追加する', exact: true }).click();
  await page.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Wallet');
  await page.getByRole('button', { name: '追加する', exact: true }).click();
  await page.getByRole('button', { name: 'Synthetic Wallet · 利用中', exact: true }).waitFor();
  await page.getByRole('button', { name: '設定へ戻る', exact: true }).click();
  await page.getByRole('button', { name: 'カテゴリ', exact: true }).click();
  await page.getByRole('button', { name: '基本カテゴリを用意する', exact: true }).click();
  await page.getByText('基本カテゴリを用意しました。', { exact: true }).waitFor();
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: '＋記録', exact: true }).click();
  await page.getByRole('button', { name: '支出', exact: true }).click();
  await page.getByRole('button', { name: 'レシートから入力', exact: true }).click();
  await page.clock.setFixedTime(new Date('2026-10-01T03:00:00Z'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64');
  await page.locator('#local-view input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: png });
  // A failed analysis can leave an empty draft behind before the next attempt.
  await page.getByText('入力内容を端末に保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '支出の選択へ戻る', exact: true }).click();
  await page.getByRole('button', { name: 'レシートから入力', exact: true }).click();
  await page.getByRole('button', { name: '未入力のレシート · 確認する', exact: true }).click();
  await page.getByRole('button', { name: 'AIで読み取る', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#receipt-merchant')?.value === 'Diagnostic Store', null, { timeout: 10000 });
  assert.equal(await page.locator('#receipt-date').inputValue(), '2026-09-30');
  assert.equal(await page.locator('#receipt-time').inputValue(), '12:00');
  assert.equal(await page.locator('#receipt-amount').inputValue(), '1280');
  assert.equal(await page.locator('#receipt-account option:checked').textContent(), 'Synthetic Wallet');
  // Reopening must recover the stored extraction without spending another AI flow.
  await page.getByRole('button', { name: '支出の選択へ戻る', exact: true }).click();
  await page.getByRole('button', { name: 'レシートから入力', exact: true }).click();
  await page.getByRole('button', { name: /Diagnostic Store/ }).click();
  assert.equal(await page.locator('#receipt-merchant').inputValue(), 'Diagnostic Store');
  assert.equal(await page.locator('#receipt-date').inputValue(), '2026-09-30');
  assert.equal(await page.locator('#receipt-amount').inputValue(), '1280');
  assert.equal(aiRequests.length, 1);
  if (process.env.PWA_RECEIPT_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RECEIPT_SCREENSHOT_PATH, fullPage: true });
  await page.clock.setFixedTime(new Date('2026-09-30T03:00:00Z'));
  assert.equal(categoryRequests[0].flowId, aiRequests[0].flowId);
  assert.equal(await page.locator('#receipt-category option:checked').textContent(), '食費');
  assert.equal(await page.getByRole('button', { name: 'カテゴリを提案する', exact: true }).count(), 0);
  await page.locator('#settings-tab').click();
  await page.getByText('AI利用 · 1 / 30回 · Free', { exact: true }).waitFor();
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: /Diagnostic Store/ }).click();
  await page.locator('#receipt-merchant').fill('Manual Store');
  await page.locator('#receipt-date').fill('2026-09-29');
  await page.locator('#receipt-time').fill('11:30');
  await page.locator('#receipt-amount').fill('1200');
  await page.getByRole('button', { name: 'AIで読み取る', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent === 'AIで読み取る' && b.disabled));
  assert.equal(await page.locator('#receipt-merchant').inputValue(), 'Diagnostic Store');
  assert.equal(await page.locator('#receipt-date').inputValue(), '2026-09-30');
  assert.equal(await page.locator('#receipt-time').inputValue(), '12:00');
  assert.equal(await page.locator('#receipt-amount').inputValue(), '1280');
  assert.equal(await page.locator('#receipt-category option:checked').textContent(), '食費');
  assert.equal(await page.locator('#receipt-account option:checked').textContent(), 'Synthetic Wallet');
  assert.equal(categoryRequests.length, 2);
  assert.equal(categoryRequests[1].flowId, aiRequests[1].flowId);
  await page.locator('#receipt-date').fill('2026-09-30');
  await page.locator('#receipt-time').fill('12:00');
  await page.locator('#receipt-amount').fill('1280');
  assert.notEqual(aiRequests[1].flowId, aiRequests[0].flowId);
  await page.locator('#settings-tab').click();
  await page.getByText('AI利用 · 2 / 30回 · Free', { exact: true }).waitFor();
  if (process.env.PWA_USAGE_SCREENSHOT_PATH) { await page.locator('#usage-summary').scrollIntoViewIfNeeded(); await page.screenshot({ path: process.env.PWA_USAGE_SCREENSHOT_PATH }); }
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: /Diagnostic Store/ }).click();
  quotaExceeded = true;
  await page.getByRole('button', { name: 'AIで読み取る', exact: true }).click();
  await page.getByText('AI利用上限に達しました。手動で入力できます。', { exact: true }).waitFor();
  assert.equal(usedFlows.size, 2);
  await page.locator('#receipt-merchant').fill('Diagnostic Store corrected');
  await page.locator('#receipt-category').selectOption({ label: '食費' });
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await page.getByText('登録しました。', { exact: true }).waitFor({ timeout: 10000 });
  assert.deepEqual(Object.keys(aiRequests[0]).sort(), ['contentType', 'flowId', 'imageBase64']);
  await page.reload();
  await page.getByText(/Diagnostic Store Corrected/i).first().waitFor();
  const headers = '取引日,出金金額（円）,入金金額（円）,海外出金金額,通貨,変換レート（円）,利用国,取引内容,取引先,取引方法,支払い区分,利用者,取引番号';
  const csv = `${headers}\n2026/09/30 12:00,1280,0,,,,,支払い,Diagnostic Store corrected,PayPay,,,synthetic-match\n2026/09/30 13:00,500,0,,,,,支払い,Synthetic New Store,PayPay,,,synthetic-unmatched\n`;
  const upload = async () => {
    await page.locator('#settings-tab').click(); await page.locator('#statement-tab').click();
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
  const openAutomaticMatch = async () => {
    const summary = page.locator('summary').filter({ hasText: '自動確認済みの内容を見る（1件）' });
    await summary.waitFor();
    assert.equal(await summary.evaluate(node => node.parentElement.open), false);
    await summary.click();
    await page.locator('summary').filter({ hasText: 'Diagnostic Store corrected' }).click();
    await page.getByText('明細：2026-09-30 12:00 · Diagnostic Store corrected · ¥1,280 · PayPay', { exact: true }).waitFor();
    await page.getByText('レシート：2026-09-30 12:00 · Diagnostic Store corrected · ¥1,280', { exact: true }).waitFor();
  };
  await openAutomaticMatch();
  if (process.env.PWA_RECONCILIATION_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RECONCILIATION_SCREENSHOT_PATH, fullPage: true });
  await page.getByRole('button', { name: 'レシートを確認する', exact: true }).click();
  await page.getByText('家計簿へ登録済みです。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '編集する', exact: true }).click();
  assert.equal(await page.locator('#receipt-merchant').inputValue(), 'Diagnostic Store corrected');
  await page.locator('#reconciliation-tab').click();
  // The latest run no longer contains the applied pair, but its history remains.
  await page.getByRole('button', { name: '照合を更新する', exact: true }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent === '照合を更新する' && b.disabled));
  await openAutomaticMatch();
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
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent === '照合を更新する' && b.disabled));
  await openAutomaticMatch();
  await upload();
  await page.getByText('0件を取り込みました。重複 2件。', { exact: true }).waitFor();
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: '＋記録', exact: true }).click();
  await page.getByRole('button', { name: '支出', exact: true }).click();
  await page.getByRole('button', { name: 'レシートから入力', exact: true }).click();
  await page.locator('#local-view input[type=file]').first().setInputFiles({ name: 'synthetic-offline.png', mimeType: 'image/png', buffer: png });
  await page.locator('#receipt-merchant').fill('Synthetic Offline Store');
  await page.locator('#receipt-amount').fill('200');
  await page.locator('#receipt-category').selectOption({ label: '食費' });
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await page.getByText('登録しました。', { exact: true }).waitFor({ timeout: 10000 });
  await page.locator('#home-tab').click();
  await page.getByText('今月の支出 ¥1,980', { exact: false }).waitFor();
  if (process.env.PWA_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_SCREENSHOT_PATH, fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: real browser ledger, mocked AI flow IDs and usage display, Gemini/Jev counted once, explicit reanalysis, manual registration after quota, receipt correction, stable reload, PayPay duplicates, automatic reconciliation, no-receipt review, offline reload/write.');
} catch (error) { console.error(await page.locator('body').innerText()); console.error('Page errors:', errors); throw error; } finally { await browser.close(); }
