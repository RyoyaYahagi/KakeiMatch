import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// docs/UX.md 登録なしのAI利用: without an account, the first AI use runs a bot check, then reads with a guest.
if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated test preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const guestSecret = 'G'.repeat(43);
const calls = { created: 0, guestTokens: 0 };
let geminiStatus = 200;

// A stand-in for Turnstile. It passes unless the page sets `__holdBotCheck`.
await context.route('https://challenges.cloudflare.com/turnstile/v0/api.js*', route => route.fulfill({
  contentType: 'text/javascript', headers: { 'cross-origin-resource-policy': 'cross-origin' },
  body: `window.turnstile = { render(container, options) {
    if (options.action !== 'guest') throw new Error('unexpected action');
    container.textContent = 'synthetic bot check';
    if (!window.__holdBotCheck) setTimeout(() => options.callback('synthetic-turnstile-token'), 50);
    return 'synthetic-widget';
  }, remove() {} };`,
}));
await context.route('**/api/ai/guest', async route => {
  const request = route.request();
  if (request.method() === 'GET') return route.fulfill({ json: { guestAvailable: true, turnstileSiteKey: '1x00000000000000000000AA' } });
  assert.equal(request.method(), 'POST');
  assert.deepEqual(request.postDataJSON(), { turnstileToken: 'synthetic-turnstile-token' });
  calls.created++; return route.fulfill({ status: 201, json: { guestSecret } });
});
await context.route('**/api/ai/token', route => {
  if (route.request().headers().authorization !== `Guest ${guestSecret}`) return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
  calls.guestTokens++; return route.fulfill({ json: { token: 'synthetic-guest-token', expiresAt: 9999999999 } });
});
await context.route('**/api/ai/usage', route => route.fulfill(route.request().headers().authorization === `Guest ${guestSecret}`
  ? { json: { plan: 'guest', period: 'day', day: '2026-10-06', used: 1, limit: 5, remaining: 4 } }
  : { status: 401, json: { error: 'unauthorized' } }));
await context.route('**/api/auth/get-session', route => route.fulfill({ json: null }));
await context.route('**/api/ai/gemini', route => {
  assert.equal(route.request().headers().authorization, 'Bearer synthetic-guest-token');
  if (geminiStatus !== 200) return route.fulfill({ status: geminiStatus, json: { error: 'ai_quota_exceeded' } });
  return route.fulfill({ json: {
    documentKind: 'receipt', merchant: 'Synthetic Guest Shop', purchasedDate: '2026-10-06', purchasedTime: null, totalAmountYen: 500, taxAmountYen: null,
    items: [{ name: 'Synthetic Bread', amountYen: 500 }], adjustments: [], warnings: [],
  } });
});
await context.route('**/api/ai/jev', route => route.fulfill({ status: 503, json: { error: 'provider_unavailable' } }));
const click = name => page.getByRole('button', { name, exact: true }).click();
const photo = async () => Buffer.from(await page.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 500;
  const context = canvas.getContext('2d'); context.fillStyle = '#f4f1ea'; context.fillRect(0, 0, 300, 500);
  context.fillStyle = '#333'; context.font = '24px sans-serif'; context.fillText('SYNTHETIC GUEST', 30, 60);
  return canvas.toDataURL('image/png').split(',')[1];
}), 'base64');
async function readReceipt() {
  await page.locator('#receipt-tab').click();
  await click('記録を追加');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: await photo() });
  await click('AIで読み取る');
}
try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0').waitFor();

  // Settings say AI works without an account.
  await page.locator('#settings-tab').click(); await click('ログイン・利用状況');
  await page.getByText('ログインしなくても、AIの読み取りを1日5回まで使えます。', { exact: true }).waitFor();

  // The first read runs the bot check once, then reads as a guest.
  await readReceipt();
  await page.waitForFunction(() => document.querySelector('#receipt-merchant')?.value === 'Synthetic Guest Shop');
  assert.equal(calls.created, 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('kakeimatch.aiGuestSecret')), guestSecret);
  assert.equal(await page.locator('.bot-check-dialog').count(), 0);
  await click('キャンセル').catch(() => {}); await page.keyboard.press('Escape');

  // After a reload the saved guest is used without another bot check.
  await page.reload(); await page.getByText('今月の支出', { exact: false }).first().waitFor();
  geminiStatus = 429;
  await readReceipt();
  await page.getByText('今日のAI読み取り（登録なしで1日5回）を使い切りました。明日の0時に戻ります。手で入力して続けられます。', { exact: true }).waitFor();
  assert.equal(calls.created, 1);
  assert.equal(await page.getByRole('button', { name: 'もう一度読み取る', exact: true }).count(), 0);
  await page.keyboard.press('Escape');

  // Settings show today's count.
  await page.locator('#settings-tab').click(); await click('ログイン・利用状況');
  await page.getByText('今日のAI読み取り 1 / 5回 · 登録なし', { exact: true }).waitFor();

  // On a device without a guest, cancelling the bot check keeps the photo and explains what happened.
  await page.evaluate(() => localStorage.removeItem('kakeimatch.aiGuestSecret'));
  await page.reload(); await page.getByText('今月の支出', { exact: false }).first().waitFor();
  await page.evaluate(() => { window.__holdBotCheck = true; });
  geminiStatus = 200;
  await readReceipt();
  const dialog = page.getByRole('dialog', { name: '確認しています' });
  await dialog.waitFor();
  if (process.env.PWA_GUEST_BOT_CHECK_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_GUEST_BOT_CHECK_SCREENSHOT_PATH });
  await dialog.getByRole('button', { name: 'やめる', exact: true }).click();
  await page.getByText('確認をやめたので、AIでは読み取りませんでした。写真は端末に残っています。手で入力するか、もう一度読み取ってください。', { exact: true }).waitFor();
  assert.equal(calls.created, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: guest AI runs a bot check once, reads without an account, explains the daily limit, shows today\'s count, and keeps the photo when the check is cancelled.');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; } finally { await browser.close(); }
