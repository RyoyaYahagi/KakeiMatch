import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { ChatGptPlanAuth } from '../../../packages/chatgpt-plan/auth';
import { ChatGptPlanClient } from '../../../packages/chatgpt-plan/client';
import { startChatGptPlanServer } from '../../../packages/chatgpt-plan/server';
import type { ChatGptRecord } from '../../../packages/chatgpt-plan/token-store';

async function test() {
  let record: ChatGptRecord | null = null; let inferenceCalls = 0; let limited = false;
  const extraction = { documentKind: 'receipt', merchant: 'Synthetic ChatGPT Store', purchasedDate: '2026-10-01', purchasedTime: null, totalAmountYen: 2400, taxAmountYen: null, items: [], warnings: [] };
  const mockFetch: typeof fetch = async url => {
    const value = String(url);
    if (value.endsWith('/oauth/token')) return Response.json({ access_token: 'synthetic-private-access', refresh_token: 'synthetic-private-refresh', id_token: 'synthetic-private-id', token_type: 'Bearer', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' });
    if (value.endsWith('/models')) return Response.json({ models: [{ slug: 'synthetic-model', display_name: 'Synthetic Model', visibility: 'list' }] });
    if (value.endsWith('/responses')) {
      inferenceCalls++;
      if (limited) return new Response('', { status: 429 });
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(extraction) }] }] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error('Unexpected synthetic URL');
  };
  const store = { read: async () => record, write: async (value: ChatGptRecord) => { record = value; } };
  const auth = new ChatGptPlanAuth(store, mockFetch, async () => 'synthetic-subject');
  const { server, origin } = await startChatGptPlanServer({ auth, client: new ChatGptPlanClient(auth, mockFetch), port: 0,
    assetsDirectory: fileURLToPath(new URL('../.cloudflare/output/v0/workers/default/assets/', import.meta.url)) });
  const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    await context.addInitScript(() => { Object.defineProperty(navigator.serviceWorker, 'register', { value: async () => ({}) }); });
    await context.route('**/api/auth/get-session', route => route.fulfill({ json: null }));
    await context.route('**/api/ai/usage', route => route.fulfill({ status: 401, json: { error: 'synthetic_signed_out' } }));
    await context.route('**/api/ai/token', route => route.fulfill({ status: 401, json: { error: 'synthetic_signed_out' } }));
    await context.route('https://auth.openai.com/api/accounts/authorize?**', route => {
      const authorization = new URL(route.request().url()); const callback = new URL('/auth/callback', origin);
      callback.searchParams.set('state', authorization.searchParams.get('state')!); callback.searchParams.set('code', 'synthetic-code'); callback.searchParams.set('client_id', 'oaiapp_synthetic');
      return route.fulfill({ status: 302, headers: { Location: callback.href }, body: '' });
    });
    const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.waitForFunction(() => document.querySelector('#message')?.textContent !== '家計簿を準備しています…');
    await page.locator('#settings-tab').click(); await page.locator('#developer-options').check();
    await page.locator('#chatgpt-plan-login').click();
    await page.waitForURL(`${origin}/#settings`); await page.locator('#settings-tab').click(); await page.locator('#developer-options').check();
    await page.locator('#chatgpt-plan-model').selectOption('synthetic-model'); await page.locator('#chatgpt-plan-enable').click();
    await page.getByText('接続済み。この端末の読み取りで使用します。', { exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.PWA_CHATGPT_SCREENSHOT_PATH) await page.locator('#chatgpt-plan-settings').screenshot({ path: process.env.PWA_CHATGPT_SCREENSHOT_PATH });
    await page.locator('#home-tab').click(); await page.getByRole('button', { name: '記録を追加', exact: true }).click();
    await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64') });
    await page.locator('#receipt-merchant').waitFor(); await page.getByRole('button', { name: 'AIで読み取る', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('#receipt-merchant') as HTMLInputElement)?.value === 'Synthetic ChatGPT Store');
    assert.equal(inferenceCalls, 1); assert.equal(await page.locator('img.receipt-preview').count(), 1);
    limited = true; page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '再読み取り', exact: true }).click();
    await page.getByText('ChatGPTプランの利用上限に達しました。手入力で登録するか、通常の読み取りに戻してください。', { exact: true }).waitFor();
    assert.equal(await page.locator('#receipt-merchant').inputValue(), extraction.merchant);
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage })); assert.equal(storage.includes('synthetic-private'), false);
    await page.evaluate(async () => { await fetch('/api/self-hosted/chatgpt/sign-out', { method: 'POST', headers: { 'content-type': 'application/json', 'x-kakeimatch-self-hosted': '1' }, body: '{}' }); });
    const signedOut = await (await fetch(`${origin}/api/self-hosted/chatgpt/status`)).json(); assert.equal(signedOut.connected, false);
    assert.deepEqual(errors, []);
    console.log('PASS self-hosted ChatGPT: 375px OAuth/settings, receipt schema validation, rate-limit draft/image preservation, no browser tokens, logout');
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
void test().catch(error => { console.error(error); process.exitCode = 1; });
