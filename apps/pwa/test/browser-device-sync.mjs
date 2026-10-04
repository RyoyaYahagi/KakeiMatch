import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { handleSyncRequest } from '../../../workers/ai-gateway/src/device-sync-api.ts';
import { InMemorySyncStorageProvider } from '../../../workers/ai-gateway/src/sync-storage-provider.ts';

// Two browsers of one synthetic user sync through the real `/api/sync` handler, run in this
// process with D1 on node:sqlite and an in-memory provider. Run with `node --import tsx`.
// The account session is synthetic; Passkey sign-in itself is covered by test:auth-e2e.
const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a synthetic-only local or preview PWA.');
const base = new URL(url);

const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
for (const name of ['0001_auth.sql', '0007_account_deletion.sql', '0009_device_sync.sql', '0011_sync_household_keys.sql']) {
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
const env = { ACCOUNT_DB: db, BETTER_AUTH_SECRET: 'x'.repeat(32) };
const getSession = async () => ({ user: { id: 'synthetic-user' }, session: { id: 'synthetic-session' } });

// Optional screenshots for review: PWA_SYNC_SCREENSHOT_DIR, PWA_SYNC_COLOR_SCHEME (light|dark), PWA_SYNC_WIDTH.
const screenshots = process.env.PWA_SYNC_SCREENSHOT_DIR;
const colorScheme = process.env.PWA_SYNC_COLOR_SCHEME === 'dark' ? 'dark' : 'light';
const width = Number(process.env.PWA_SYNC_WIDTH ?? 375);
const shot = async (page, name) => {
  if (screenshots) await page.locator('#device-sync-settings').screenshot({
    path: `${screenshots}/sync-${name}-${colorScheme}-${width}.png`,
    mask: [page.locator('#sync-recovery-code')],
  });
};

const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const errors = [];

async function device(name) {
  const context = await browser.newContext({ viewport: { width, height: 812 }, colorScheme });
  const network = { offline: false, dropNextKeyPutResponse: false };
  await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
  await context.route('**/api/sync/**', async route => {
    if (network.offline) return route.abort('internetdisconnected');
    const request = route.request();
    const loseKeyResponse = network.dropNextKeyPutResponse && request.method() === 'PUT'
      && new URL(request.url()).pathname === '/api/sync/key';
    const headers = new Headers(request.headers());
    const body = request.postDataBuffer();
    if (body) headers.set('content-length', String(body.byteLength));
    const response = await handleSyncRequest(new Request(request.url(), { method: request.method(), headers, body: body ?? undefined }), env, { provider, getSession });
    if (loseKeyResponse) {
      network.dropNextKeyPutResponse = false;
      return route.abort('connectionreset');
    }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  await context.route(/\/api\/(?!sync\/)/, route => {
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
    page, context, click,
    async setOffline(offline) { network.offline = offline; await context.setOffline(offline); },
    loseNextKeyPutResponse() { network.dropNextKeyPutResponse = true; },
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
    async openSync() {
      await page.locator('#settings-tab').click();
      await page.locator('#device-sync-settings').scrollIntoViewIfNeeded();
    },
    async status(label) { await page.locator('#sync-status', { hasText: label }).waitFor({ timeout: 20000 }); },
  };
}

try {
  const a = await device('A');
  await a.addAccount('Synthetic Wallet A');
  await a.openSync();
  assert.equal(await a.page.locator('#sync-status').isVisible(), false, 'sync is off by default');
  await shot(a.page, 'off');

  // The server stores the protected key, then its first response is lost. Retrying setup must
  // reuse the same device and recovery code while keeping sync off until the user confirms.
  a.loseNextKeyPutResponse();
  await a.click('この端末で同期を始める');
  await a.page.getByText('オフラインのため完了できませんでした。', { exact: false }).waitFor();
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sync_versions WHERE state = 'published'").get().count, 0, 'a failed setup has not published a household');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sync_devices').get().count, 1, 'retry has one registered device');

  await a.click('この端末で同期を始める');
  const codeBeforeReload = await a.page.locator('#sync-recovery-code').innerText();
  assert.ok(/^KM1-[0-9a-f]{8}(-[0-9a-f]{8}){7}$/.test(codeBeforeReload), 'the recovery code has the expected format');
  assert.equal(await a.page.getByRole('button', { name: '続ける', exact: true }).isDisabled(), true, 'continuing requires confirming the code is stored');
  await shot(a.page, 'recovery-code');

  await a.page.evaluate(() => window.dispatchEvent(new Event('online')));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sync_versions WHERE state = 'published'").get().count, 0, 'online does not publish before setup confirmation');
  await a.page.reload();
  await a.page.getByText('今月の支出 ¥0', { exact: false }).waitFor();
  await a.openSync();
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sync_versions WHERE state = 'published'").get().count, 0, 'reload does not publish before setup confirmation');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sync_devices').get().count, 1, 'reload and retry do not register another device');
  await a.click('この端末で同期を始める');
  const code = await a.page.locator('#sync-recovery-code').innerText();
  assert.ok(code === codeBeforeReload, 'retry after reload shows the same recovery code');
  assert.equal(await a.page.getByRole('button', { name: '続ける', exact: true }).isDisabled(), true, 'continuing remains disabled until confirmation');
  await shot(a.page, 'recovery-code');
  await a.page.getByLabel('復旧コードを端末の外（パスワード管理アプリなど）に保存しました').check();
  await a.click('続ける');
  await a.status('同期済み');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sync_versions WHERE state = 'published'").get().count, 1, 'sync publishes after setup confirmation');
  await a.page.getByText('端末間の同期がオンです。', { exact: false }).waitFor();
  assert.ok(await a.page.locator('#sync-status').evaluate(node => node.textContent.includes('✓')), 'the status has a symbol and a label');
  await shot(a.page, 'synced');
  assert.ok(await a.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow at 375px');

  // The second device keeps its own data as the previous household and opens the synced one.
  const b = await device('B');
  await b.addAccount('Synthetic Local B');
  await b.openSync();
  await b.click('別の端末の同期に参加する');
  await b.page.getByLabel('復旧コード', { exact: true }).fill('KM1-00000000-00000000-00000000-00000000-00000000-00000000-00000000-00000000');
  await b.click('参加する');
  await b.page.getByText('復旧コードが違います。', { exact: false }).waitFor();
  await b.page.getByLabel('復旧コード', { exact: true }).fill(code);
  const joined = b.page.waitForNavigation({ waitUntil: 'load' });
  await b.click('参加する');
  await joined;
  await b.page.getByText('今月の支出 ¥0', { exact: false }).waitFor();
  assert.deepEqual(await b.accounts(), ['Synthetic Wallet A · 利用中']);
  assert.equal(await b.page.locator('#restore-previous').isDisabled(), false, 'the joining device keeps its own household');

  // A save on B is sent shortly after; A receives it with "今すぐ同期".
  await b.addAccount('Synthetic Wallet B');
  await b.openSync();
  await b.status('同期済み');
  await a.openSync();
  const received = a.page.waitForNavigation({ waitUntil: 'load' });
  await a.click('今すぐ同期');
  await received;
  assert.deepEqual(await a.accounts(), ['Synthetic Wallet A · 利用中', 'Synthetic Wallet B · 利用中']);

  // Offline edits on both devices are a conflict. Nothing is merged; the user chooses.
  await b.setOffline(true);
  await b.addAccount('Synthetic Offline B');
  await b.openSync();
  await b.status('オフライン');
  await a.addAccount('Synthetic Online A');
  await a.openSync();
  await a.status('同期済み');
  await b.setOffline(false);
  await b.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await b.page.getByText('両方の端末で変更されています。内容を確認してください。', { exact: true }).waitFor({ timeout: 20000 });
  await b.status('別の端末の変更があります');
  await shot(b.page, 'conflict');
  await b.click('この端末の内容を使う');
  await b.status('同期済み');
  await a.openSync();
  const chosen = a.page.waitForNavigation({ waitUntil: 'load' });
  await a.click('今すぐ同期');
  await chosen;
  assert.deepEqual(await a.accounts(), ['Synthetic Offline B · 利用中', 'Synthetic Wallet A · 利用中', 'Synthetic Wallet B · 利用中']);

  // Only ciphertext is stored.
  for (const key of provider.keys()) {
    const object = await provider.get(key);
    assert.ok(!Buffer.from(await new Response(object.body).arrayBuffer()).includes('Synthetic Wallet'), 'stored objects are encrypted');
  }

  // Stopping on one device and deleting cloud data keep local data.
  await b.openSync();
  await b.page.locator('#sync-manage summary').click();
  await b.click('この端末の同期を停止');
  await b.page.getByText('この端末の同期を停止しました。', { exact: false }).waitFor();
  await a.openSync();
  await a.page.locator('#sync-manage summary').click();
  await a.click('クラウドの同期データをすべて削除');
  await a.page.getByText('クラウドの同期データを削除しました。', { exact: false }).waitFor();
  assert.deepEqual(provider.keys(), []);
  assert.equal((await a.accounts()).length, 3);
  assert.deepEqual(errors, []);
  console.log('PASS: two browsers enable, join with a recovery code, sync both ways, resolve an offline conflict without merging, stop, and delete cloud data. Only ciphertext reached storage.');
} finally {
  await browser.close();
  sqlite.close();
}
