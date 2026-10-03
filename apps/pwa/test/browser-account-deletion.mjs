import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const url = process.env.PWA_E2E_URL ?? 'http://127.0.0.1:4175';
const screenshotPath = resolve(process.env.PWA_ACCOUNT_DELETION_SCREENSHOT_PATH ?? '/tmp/issue-151-account-deletion.png');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });

let accountDeleted = false;
const deletionRequests = [];
await context.route('**/api/**', async route => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (path.endsWith('/api/auth/get-session')) {
    await route.fulfill({ json: accountDeleted ? null : { user: { id: 'synthetic-user', name: 'Synthetic User' }, session: { id: 'synthetic-session', expiresAt: '2099-01-01T00:00:00Z' } } });
    return;
  }
  if (path.endsWith('/api/auth/passkey/list-user-passkeys')) { await route.fulfill({ json: [] }); return; }
  if (path.endsWith('/api/ai/usage')) { await route.fulfill({ json: { plan: 'free', month: '2026-10', used: 2, limit: 30, remaining: 28 } }); return; }
  if (path === '/api/account/delete') {
    deletionRequests.push({ method: request.method(), body: request.postData() });
    accountDeleted = true;
    await route.fulfill({ json: { deleted: true, localHouseholdDataPreserved: true } });
    return;
  }
  await route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } });
});

const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-01T03:00:00Z'));
page.on('pageerror', error => console.error(`PAGE ERROR: ${error.stack ?? error.message}`));
try {
  await page.goto(url);
  await page.getByText('今月の支出 ¥0').waitFor();
  const click = name => page.getByRole('button', { name, exact: true }).click();

  await page.locator('#settings-tab').click();
  await click('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Wallet'); await click('追加する');
  await page.getByRole('button', { name: 'Synthetic Wallet · 利用中', exact: true }).waitFor();
  await page.locator('#settings-tab').click();
  await click('カテゴリ'); await click('カテゴリを追加する');
  await page.getByLabel('カテゴリ名', { exact: true }).fill('Synthetic Food'); await click('追加する');
  await page.getByRole('button', { name: /^Synthetic Food ·/ }).waitFor();
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('支出を手入力');
  await page.locator('#manual-transaction-payee').fill('Synthetic Shop');
  await page.locator('#manual-transaction-amount').fill('1500');
  await page.locator('#manual-transaction-date').fill('2026-10-01');
  await page.locator('#manual-transaction-category').selectOption({ label: 'Synthetic Food' });
  await page.locator('#manual-transaction-account').selectOption({ label: 'Synthetic Wallet' });
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();

  await page.locator('#settings-tab').click();
  await page.getByRole('button', { name: 'アカウントを削除', exact: true }).waitFor();
  await mkdir(dirname(screenshotPath), { recursive: true });
  await page.getByRole('button', { name: 'アカウントを削除', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshotPath });

  page.once('dialog', dialog => { void dialog.dismiss(); });
  await click('アカウントを削除');
  assert.equal(deletionRequests.length, 0, 'cancel does not start deletion');

  page.on('dialog', dialog => {
    if (dialog.type() === 'confirm') return dialog.accept();
    if (dialog.type() === 'prompt') return dialog.accept('アカウントを削除');
    return dialog.dismiss();
  });
  await click('アカウントを削除');
  await page.getByText('家計簿・レシート・明細・照合記録はこの端末に残っています。引き続き利用できます。', { exact: true }).waitFor();
  assert.deepEqual(deletionRequests, [{ method: 'DELETE', body: null }], 'client sends a bodyless same-origin DELETE');
  assert.equal(await page.locator('#signed-in-actions').isHidden(), true);
  assert.equal(await page.locator('#signed-out-actions').isHidden(), false);

  await page.locator('#home-tab').click();
  await page.getByText('今月の支出 ¥1,500', { exact: false }).waitFor();
  await page.locator('#transactions').getByText('Synthetic Shop', { exact: true }).waitFor();
  await page.locator('#settings-tab').click();
  assert.equal(await page.locator('#backup-export').isVisible(), true, 'local backup remains available');
  assert.equal(await page.getByText('原本の整理・全削除', { exact: true }).isVisible(), true, 'local original management and clear-all remain available');
  console.log(`PASS: explicit cancel and confirmation, bodyless account deletion, local synthetic ledger and backup remain available; screenshot ${screenshotPath}`);
} catch (error) {
  const body = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '<page content unavailable>');
  console.error(`FAILED at ${page.url()}:\n${body}`);
  throw error;
} finally {
  await browser.close();
}
