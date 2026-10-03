import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to an isolated synthetic PWA preview.');
const merchant = 'Synthetic XSS Store <img src=x onerror=window.__kakeimatchXss=1>';
const itemName = 'Synthetic XSS Item <img src=x onerror=window.__kakeimatchXss=1>';
const memo = 'Synthetic XSS Memo <img src=x onerror=window.__kakeimatchXss=1>';
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addInitScript(() => {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', event => window.__cspViolations.push({
    directive: event.violatedDirective, blockedURI: event.blockedURI,
    sourceFile: event.sourceFile, lineNumber: event.lineNumber, sample: event.sample,
  }));
});
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-09-30T03:00:00Z'));
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();
async function assertOnlyBlockedEvalProbe() {
  const violations = await page.evaluate(() => window.__cspViolations);
  assert.ok(violations.every(violation => violation.directive === 'script-src' && violation.blockedURI === 'eval' && new URL(violation.sourceFile).pathname.startsWith('/assets/index-')),
    `Unexpected CSP violation: ${JSON.stringify(violations)}`);
}

try {
  const response = await page.goto(url);
  const csp = response?.headers()['content-security-policy'] ?? '';
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /connect-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /worker-src 'self' blob: data:/);
  assert.equal(await page.evaluate(() => crossOriginIsolated && typeof SharedArrayBuffer === 'function'), true);
  await page.getByText('今月の支出 ¥0').waitFor();

  await page.locator('#settings-tab').click();
  await click('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill('Synthetic XSS Wallet'); await click('追加する');
  await page.getByRole('button', { name: 'Synthetic XSS Wallet · 利用中', exact: true }).waitFor();
  await page.locator('#settings-tab').click(); await click('カテゴリ'); await click('基本カテゴリを用意する');
  await page.getByText('基本カテゴリを用意しました。', { exact: true }).waitFor();

  await page.locator('#receipt-tab').click(); await click('記録を追加');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic-security.png', mimeType: 'image/png', buffer: png });
  await page.locator('#receipt-merchant').fill(merchant);
  await page.locator('#receipt-date').fill('2026-09-30');
  await page.locator('#receipt-amount').fill('1280');
  await page.locator('#receipt-category').selectOption({ label: '食費' });
  await page.getByRole('button', { name: '品目を追加', exact: true }).click();
  await page.locator('[data-item-name]').fill(itemName);
  await page.locator('[data-item-amount]').fill('1280');
  for (const summary of await page.locator('details.optional-fields:not([open]) > summary').all()) await summary.click();
  await page.locator('#receipt-memo').fill(memo);
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();

  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: /^Synthetic Xss Store/i }).click();
  await page.getByRole('heading', { name: merchant, exact: true }).waitFor();
  await page.getByText(`メモ：${memo}`, { exact: true }).waitFor();
  await page.locator('details.detail-disclosure summary').filter({ hasText: '購入内容' }).click();
  await page.getByText(`${itemName} · ¥1,280 · 食費`, { exact: true }).waitFor();
  assert.equal(await page.locator('img[src="x"]').count(), 0);
  assert.equal(await page.evaluate(() => window.__kakeimatchXss), undefined);
  await assertOnlyBlockedEvalProbe();

  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  await context.setOffline(true);
  const offlineResponse = await page.reload();
  assert.equal(offlineResponse?.headers()['content-security-policy'], csp);
  await page.getByText('オフライン', { exact: true }).waitFor();
  await page.getByText('今月の支出 ¥1,280', { exact: false }).waitFor();
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: /^Synthetic Xss Store/i }).click();
  await page.getByRole('heading', { name: merchant, exact: true }).waitFor();
  await page.getByText(`メモ：${memo}`, { exact: true }).waitFor();
  await page.locator('details.detail-disclosure summary').filter({ hasText: '購入内容' }).click();
  await page.getByText(`${itemName} · ¥1,280 · 食費`, { exact: true }).waitFor();
  assert.equal(await page.locator('img[src="x"]').count(), 0);
  assert.equal(await page.evaluate(() => window.__kakeimatchXss), undefined);
  assert.deepEqual(errors, []);
  await assertOnlyBlockedEvalProbe();
  console.log('PASS: CSP permits Actual SharedArrayBuffer/WebAssembly and service-worker offline use; merchant, item, and memo payloads remain text online and offline; only the caught general-eval feature probe is blocked.');
} catch (error) {
  console.error(await page.locator('body').innerText().catch(() => '<page unavailable>'));
  console.error('Page errors:', errors);
  throw error;
} finally {
  await browser.close();
}
