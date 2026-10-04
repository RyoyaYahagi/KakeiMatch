import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { handleSyncRequest } from '../../../workers/ai-gateway/src/device-sync-api.ts';
import { InMemorySyncStorageProvider } from '../../../workers/ai-gateway/src/sync-storage-provider.ts';

// Two browsers of one synthetic user sync through Google Drive. The `/api/sync` handler is real
// (D1 on node:sqlite); Google's consent page and the Drive API are synthetic stand-ins served by
// Playwright routes. Run with `node --import tsx`. No request reaches Google.
const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a synthetic-only local or preview PWA.');
const base = new URL(url);

const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
for (const name of ['0001_auth.sql', '0007_account_deletion.sql', '0009_device_sync.sql', '0011_sync_household_keys.sql', '0012_sync_external_storage.sql']) {
  sqlite.exec(readFileSync(new URL(`../../../workers/ai-gateway/migrations/${name}`, import.meta.url), 'utf8'));
}
sqlite.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES ('synthetic-user','Synthetic','synthetic@example.invalid',1,1)").run();
sqlite.prepare("INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES ('synthetic-session','2099-01-01T00:00:00.000Z','t',?,?,'synthetic-user')")
  .run(new Date().toISOString(), new Date().toISOString());
const prepare = query => {
  const statement = {
    query, values: [],
    bind(...values) { statement.values = values; return statement; },
    async first() { return sqlite.prepare(query).get(...statement.values) ?? null; },
    async all() { return { results: sqlite.prepare(query).all(...statement.values) }; },
    async run() { return { success: true, meta: { changes: Number(sqlite.prepare(query).run(...statement.values).changes) } }; },
  };
  return statement;
};
const db = {
  prepare,
  async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const results = statements.map(s => ({ success: true, meta: { changes: Number(sqlite.prepare(s.query).run(...s.values).changes) } }));
      sqlite.exec('COMMIT');
      return results;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  },
};
const provider = new InMemorySyncStorageProvider();
const env = { ACCOUNT_DB: db, BETTER_AUTH_SECRET: 'x'.repeat(32), GOOGLE_OAUTH_CLIENT_ID: 'synthetic-client.apps.googleusercontent.com' };
const getSession = async () => ({ user: { id: 'synthetic-user' }, session: { id: 'synthetic-session' } });


// The user's Drive app folder, shared by both browsers of the same Google account.
const driveFiles = new Map();
const revokedTokens = new Set();
let tokenCount = 0;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, DELETE' };

async function fakeGoogle(route) {
  const request = route.request();
  const target = new URL(request.url());
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  if (target.hostname === 'accounts.google.com') {
    assert.equal(target.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.appdata');
    const token = `synthetic-token-${++tokenCount}`;
    const reply = new URLSearchParams({ access_token: token, token_type: 'Bearer', expires_in: '3600', scope: target.searchParams.get('scope'), state: target.searchParams.get('state') });
    return route.fulfill({ status: 302, headers: { location: `${target.searchParams.get('redirect_uri')}#${reply}` } });
  }
  if (target.hostname === 'oauth2.googleapis.com') {
    revokedTokens.add(new URLSearchParams(request.postData() ?? '').get('token'));
    return route.fulfill({ status: 200, headers: cors, body: '' });
  }
  const token = (request.headers().authorization ?? '').replace('Bearer ', '');
  if (!token.startsWith('synthetic-token-') || revokedTokens.has(token)) return route.fulfill({ status: 401, headers: cors, json: { error: { code: 401 } } });
  if (target.pathname === '/upload/drive/v3/files' && request.method() === 'POST') {
    const raw = request.postDataBuffer();
    const marker = Buffer.from('content-type: application/octet-stream\r\n\r\n');
    const start = raw.indexOf(marker) + marker.length;
    const end = raw.lastIndexOf(Buffer.from('\r\n--'));
    const metadata = JSON.parse(raw.toString('latin1').match(/\{"name":[^\r\n]*\}/)[0]);
    assert.deepEqual(metadata.parents, ['appDataFolder']);
    const id = `driveFile${driveFiles.size + 1}x${Date.now()}`;
    driveFiles.set(id, { name: metadata.name, bytes: Buffer.from(raw.subarray(start, end)), createdTime: '2000-01-01T00:00:00.000Z' });
    return route.fulfill({ status: 200, headers: cors, json: { id } });
  }
  if (target.pathname === '/drive/v3/about') return route.fulfill({ status: 200, headers: cors, json: { user: { emailAddress: 'synthetic-drive@example.test' } } });
  if (target.pathname === '/drive/v3/files' && request.method() === 'GET') {
    return route.fulfill({ status: 200, headers: cors, json: { files: [...driveFiles].map(([id, file]) => ({ id, name: file.name, createdTime: file.createdTime })) } });
  }
  const id = decodeURIComponent(target.pathname.split('/').pop());
  const file = driveFiles.get(id);
  if (request.method() === 'DELETE') { driveFiles.delete(id); return route.fulfill({ status: 204, headers: cors, body: '' }); }
  if (!file) return route.fulfill({ status: 404, headers: cors, json: { error: { code: 404 } } });
  return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/octet-stream' }, body: file.bytes });
}

const screenshots = process.env.PWA_SYNC_SCREENSHOT_DIR;
const shot = async (page, name) => { if (screenshots) await page.locator('#device-sync-settings').screenshot({ path: `${screenshots}/drive-${name}.png` }); };

const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const errors = [];

async function device(name) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
  await context.route(/^https:\/\/(accounts\.google\.com|www\.googleapis\.com|oauth2\.googleapis\.com)\//, fakeGoogle);
  await context.route('**/api/sync/**', async route => {
    const request = route.request();
    const headers = new Headers(request.headers());
    const body = request.postDataBuffer();
    if (body) headers.set('content-length', String(body.byteLength));
    const response = await handleSyncRequest(new Request(request.url(), { method: request.method(), headers, body: body ?? undefined }), env, { provider, getSession });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  await context.route(/127\.0\.0\.1:\d+\/api\/(?!sync\/)/, route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/get-session') return route.fulfill({ json: { user: { id: 'synthetic-user', name: 'Synthetic' }, session: { id: 'synthetic-session', expiresAt: '2099-01-01T00:00:00Z' } } });
    if (path === '/api/ai/usage') return route.fulfill({ json: { plan: 'free', used: 0, limit: 30, remaining: 30 } });
    if (path.includes('passkey')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 403, json: { error: 'synthetic' } });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  page.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? '同期データを削除' : undefined));
  await page.goto(base.href);
  await page.getByText('今月の支出 ¥0', { exact: false }).waitFor();
  const click = label => page.getByRole('button', { name: label, exact: true }).click();
  return {
    page, click,
    token: () => page.evaluate(() => JSON.parse(sessionStorage.getItem('kakeimatch.google-drive-token.v1') ?? 'null')?.accessToken ?? null),
    async addAccount(label) {
      await page.locator('#settings-tab').click();
      await click('支払元'); await click('支払元を追加する');
      await page.getByLabel('支払元の名前', { exact: true }).fill(label); await click('追加する');
      await page.getByRole('button', { name: `${label} · 利用中`, exact: true }).waitFor();
    },
    async accounts() {
      await page.locator('#settings-tab').click();
      await click('支払元');
      await page.locator('.account-total').waitFor();
      return page.locator('button[aria-label]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? '').filter(label => label.endsWith('· 利用中')).sort());
    },
    /** Waits until the active household is the synced one and the reloaded page is ready. */
    async imported() {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const bound = await page.evaluate(() => {
          const profile = localStorage.getItem('kakeimatch.local-profile.v1');
          const state = JSON.parse(localStorage.getItem(`kakeimatch.household-sync.v1:${profile}`) ?? 'null');
          return Boolean(state?.householdId) && document.readyState === 'complete';
        }).catch(() => false);
        if (bound) { await page.locator('#settings-tab').waitFor(); return; }
        await page.waitForTimeout(250);
      }
      throw new Error(`${name} did not import the synced household`);
    },
    async openSync() { await page.locator('#settings-tab').click(); await page.locator('#device-sync-settings').scrollIntoViewIfNeeded(); },
    async status(label) { await page.locator('#sync-status', { hasText: label }).waitFor({ timeout: 20000 }); },
  };
}

try {
  const a = await device('A');
  await a.addAccount('Synthetic Drive Wallet A');
  await a.openSync();
  await a.page.getByLabel('Google Drive', { exact: true }).check();
  await shot(a.page, 'choice');
  // Starting with Google Drive leaves for Google's page and comes back to the same screen.
  const toGoogle = a.page.waitForNavigation({ waitUntil: 'load' });
  await a.click('この端末で同期を始める');
  await toGoogle;
  await a.page.locator('#sync-recovery-code').waitFor({ timeout: 20000 });
  assert.equal(new URL(a.page.url()).hash, '', 'the token is removed from the address bar');
  const code = await a.page.locator('#sync-recovery-code').innerText();
  await a.page.getByLabel('復旧コードを端末の外（パスワード管理アプリなど）に保存しました').check();
  await a.click('続ける');
  await a.status('同期済み');
  await a.page.locator('#sync-storage', { hasText: '保存先：Google Drive（synthetic-drive@example.test）' }).waitFor();
  await shot(a.page, 'synced');
  assert.equal(provider.keys().length, 0, 'nothing is stored in KakeiMatch Cloud');
  assert.ok(driveFiles.size > 0);
  for (const file of driveFiles.values()) {
    assert.match(file.name, /^kakeimatch-sync-[0-9a-f-]{36}$/);
    assert.ok(!file.bytes.includes('Synthetic Drive Wallet'), 'Drive receives ciphertext only');
  }

  // The second browser joins; it needs its own Google Drive connection to read the files.
  const b = await device('B');
  await b.openSync();
  await b.click('別の端末の同期に参加する');
  await b.page.getByLabel('復旧コード', { exact: true }).fill(code);
  await b.click('参加する');
  await b.status('Google Driveへの再接続が必要です');
  const reconnect = b.page.waitForNavigation({ waitUntil: 'load' });
  await b.click('Google Driveに再接続');
  await reconnect;
  // Returning from Google imports the household, which reloads the page once more.
  await b.imported();
  assert.deepEqual(await b.accounts(), ['Synthetic Drive Wallet A · 利用中']);

  // An expired Google sign-in stops syncing but keeps the household on the device.
  revokedTokens.add(await a.token());
  await a.addAccount('Synthetic Offline Drive Wallet');
  await a.openSync();
  await a.status('Google Driveへの再接続が必要です');
  await shot(a.page, 'reconnect');
  assert.equal((await a.accounts()).length, 2);

  // Disconnecting does not delete data; deleting Drive data is a separate, explicit action.
  await b.openSync();
  await b.page.locator('#sync-manage summary').click();
  await b.click('Google Driveの接続を解除');
  await b.status('Google Driveへの再接続が必要です');
  assert.ok(driveFiles.size > 0, 'disconnecting keeps the Drive data');
  await b.page.locator('#sync-manage summary').click();
  await b.click('Google Drive上の同期データを削除');
  await b.page.getByText('Google Driveに接続してから削除してください。削除済みではありません。', { exact: true }).waitFor();
  assert.ok(driveFiles.size > 0);

  await a.openSync();
  const back = a.page.waitForNavigation({ waitUntil: 'load' });
  await a.click('Google Driveに再接続');
  await back;
  await a.status('同期済み');
  await a.openSync();
  await a.page.locator('#sync-manage summary').click();
  await a.click('Google Drive上の同期データを削除');
  await a.page.getByText('Google Drive上の同期データを削除しました。', { exact: false }).waitFor({ timeout: 20000 });
  assert.equal(driveFiles.size, 0);
  assert.equal((await a.accounts()).length, 2, 'local data stays after deleting Drive data');
  assert.deepEqual(errors, []);
  console.log('PASS: Google Drive sync via redirect sign-in, two browsers, ciphertext only in Drive, reconnect after expiry, and disconnect separated from deleting Drive data. No request reached Google.');
} finally {
  await browser.close();
  sqlite.close();
}
