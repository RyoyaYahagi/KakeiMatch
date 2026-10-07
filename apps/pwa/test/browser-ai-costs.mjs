import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'America/Los_Angeles' });
await context.addInitScript(() => {
  navigator.serviceWorker.register = async () => ({});
  if (sessionStorage.getItem('synthetic-block-developer-setting') === 'true') {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'kakeimatch:developer-options') throw new Error('synthetic storage read failure');
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'kakeimatch:developer-options') throw new Error('synthetic storage write failure');
      return setItem.call(this, key, value);
    };
  }
});
let signedIn = true;
let invalidCosts = false;
const requestedMonths = [];
await context.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname.endsWith('/api/auth/get-session')) {
    return route.fulfill({ json: signedIn ? { user: { id: 'synthetic-user', name: 'Synthetic User' }, session: { id: 'synthetic-session', expiresAt: '2099-01-01T00:00:00Z' } } : null });
  }
  if (url.pathname.endsWith('/api/ai/usage')) return route.fulfill({ json: { plan: 'free', used: 2, limit: 10, remaining: 8 } });
  if (url.pathname.endsWith('/api/ai/costs')) {
    const month = url.searchParams.get('month');
    requestedMonths.push(month);
    const payload = {
      month, currency: 'USD', totalUsdMicros: 1234567, unknownRequests: 2,
      providers: {
        gemini: { requests: 3, inputTokens: 1200, outputTokens: 300, costUsdMicros: 1000000, unknownRequests: 1 },
        jev: { requests: 2, inputTokens: 600, outputTokens: 150, costUsdMicros: 234567, unknownRequests: 1 },
      },
    };
    if (invalidCosts) payload.providers.gemini.requests = -1;
    return route.fulfill({ json: payload });
  }
  if (url.pathname.includes('passkey') && url.pathname.includes('list')) return route.fulfill({ json: [] });
  if (url.pathname.endsWith('/api/auth/sign-out')) { signedIn = false; return route.fulfill({ json: { success: true } }); }
  return route.fulfill({ json: {} });
});

const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-01T01:00:00Z'));
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();
try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0', { exact: false }).waitFor();
  // The developer option lives in アプリ情報; the costs it reveals are in ログイン・利用状況.
  await page.locator('#settings-tab').click(); await click('アプリ情報');
  assert.equal(await page.locator('#developer-options').isChecked(), false);
  assert.equal(requestedMonths.length, 0, 'costs are not requested when developer options are off');

  await page.locator('#developer-options').check();
  await click('設定へ戻る'); await click('ログイン・利用状況');
  await page.getByText('合計 US$1.234567', { exact: true }).waitFor();
  await page.getByText('料金を確定できない要求が2件あります。合計には計測できた料金だけを含みます。', { exact: true }).waitFor();
  await page.getByText('3件 · 入力 1,200 / 出力 300 トークン · US$1.00', { exact: true }).waitFor();
  assert.deepEqual(requestedMonths, ['2026-10']);
  invalidCosts = true;
  await click('前月のAI利用料金');
  await page.locator('#costs-month').getByText('2026年9月', { exact: true }).waitFor();
  await page.getByText('利用料金を取得できません。オンラインで再度お試しください。', { exact: true }).waitFor();
  assert.equal(await page.locator('#costs-providers li').count(), 0, 'invalid provider values are rejected and stale rows are cleared');
  invalidCosts = false;
  await click('翌月のAI利用料金');
  await page.getByText('合計 US$1.234567', { exact: true }).waitFor();
  await page.locator('#costs-month').getByText('2026年10月', { exact: true }).waitFor();
  assert.deepEqual(requestedMonths, ['2026-10', '2026-09', '2026-10']);
  if (process.env.PWA_AI_COSTS_SCREENSHOT_PATH) {
    await page.locator('#developer-costs').scrollIntoViewIfNeeded();
    await page.screenshot({ path: process.env.PWA_AI_COSTS_SCREENSHOT_PATH });
  }

  await click('ログアウト');
  await page.getByText('未ログインです。', { exact: true }).waitFor();
  await page.reload();
  await page.locator('#settings-tab').click(); await click('ログイン・利用状況');
  await page.getByText('ログインしなくても、AIの読み取りを1日5回まで使えます。', { exact: true }).waitFor();
  assert.equal(await page.locator('#developer-options').isChecked(), true, 'developer preference stays on this browser after reload');
  assert.equal(await page.locator('#developer-costs').isVisible(), false, 'costs stay inside the signed-in AI account');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => sessionStorage.setItem('synthetic-block-developer-setting', 'true'));
  await page.reload();
  await page.getByText('今月の支出 ¥0', { exact: false }).waitFor();
  await page.locator('#settings-tab').click(); await click('アプリ情報');
  assert.equal(await page.locator('#developer-options').isChecked(), false, 'unavailable local storage falls back to the default without breaking the app');
  await page.getByText('端末設定を読み取れません。この画面を開いている間は初期設定で動作します。', { exact: true }).waitFor();
  await page.locator('#developer-options').check();
  assert.equal(await page.locator('#developer-options').isChecked(), true, 'the toggle remains usable in memory when local storage writes fail');
  await page.getByText('設定を保存できませんでした。この画面を開いている間だけ有効です。', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: developer option defaults off and persists locally, Asia/Tokyo month is used across browser timezones, cost responses are validated, month changes clear stale data, unknown-cost warnings render, costs remain hidden when signed out, and 375px layout has no horizontal overflow');
} catch (error) {
  console.log(await page.locator('body').innerText());
  throw error;
} finally { await browser.close(); }
