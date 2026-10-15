import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { pbkdf2Sync } from 'node:crypto';
import { chromium } from 'playwright-core';

const app = process.env.PWA_E2E_URL;
if (!app) throw new Error('Set PWA_E2E_URL to an isolated synthetic PWA.');
const example = new URL('../../../examples/food-purchases/', import.meta.url);
const server = createServer(async (request, response) => {
  try {
    const file = request.url === '/client.mjs' ? 'client.mjs' : 'index.html';
    response.writeHead(200, { 'content-type': file.endsWith('mjs') ? 'application/javascript' : 'text/html', 'cross-origin-opener-policy': 'same-origin-allow-popups' });
    response.end(await readFile(new URL(file, example)));
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const externalOrigin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
const page = await context.newPage();
const errors = []; context.on('page', current => current.on('pageerror', error => errors.push(error.message)));
page.on('pageerror', error => errors.push(error.message));
async function seed(categoryId) {
  await page.evaluate(async categoryId => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('kakeimatch-local-data'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const profileId = localStorage.getItem('kakeimatch.local-profile.v1');
    const id = 'receipt:synthetic-food'; const now = '2026-10-15T00:00:00.000Z';
    const receipt = { id, createdAt: now, updatedAt: now, image: null, extraction: null,
      aiSuggestion: { categoryId: null, source: 'unclassified', probabilities: null, model: null, attemptedAt: null },
      confirmedValue: { merchant: '合成スーパー', purchasedDate: '2026-10-14', purchasedTime: null, totalAmountYen: 500, categoryId,
        accountId: 'private-account', memo: 'private memo', items: [
          { id: 'apple', name: '合成りんご', amountYen: 300, quantity: 2, categoryId },
          { id: 'soap', name: '非公開のせっけん', amountYen: 200, categoryId: 'private-daily' } ] },
      registration: { status: 'applied', actualTransactionId: 'synthetic-tx', lastError: null } };
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put({ id, profileId, key: `${profileId}\u0000${id}`, kind: 'receipt-metadata', value: receipt, updatedAt: now }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  }, categoryId);
}
try {
  await page.goto(app); await page.getByText('今月の支出 ¥0').waitFor();
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  await page.locator('#settings-tab').click(); await page.getByRole('button', { name: '食品情報の連携', exact: true }).click();
  await page.getByLabel('連携先の名前', { exact: true }).fill('合成レシピアプリ');
  await page.getByLabel('連携先のサイトURL', { exact: true }).fill(externalOrigin);
  await page.getByText('共有するカテゴリを選ぶ', { exact: true }).click();
  const food = page.getByLabel('食費', { exact: true }); await food.check();
  const foodCategoryId = await food.getAttribute('value');
  await seed(foodCategoryId);
  await page.getByRole('button', { name: '食品情報の連携を許可', exact: true }).click();
  const token = await page.getByLabel('連携キー（この画面で一度だけ表示）', { exact: true }).inputValue();
  assert.match(token, /^[a-f0-9]{64}$/);
  await mkdir('../../docs/screenshots', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    // Do not put even synthetic tokens in committed screenshots.
    await page.getByLabel('連携キー（この画面で一度だけ表示）').evaluate(node => { node.value = '連携キーは非表示'; });
    await page.screenshot({ path: `../../docs/screenshots/food-connections-${theme}-375.png`, fullPage: true });
  }
  const client = await context.newPage(); await client.goto(externalOrigin);
  await client.locator('#app-origin').fill(app); await client.locator('#token').fill(token);
  const popupPromise = context.waitForEvent('page');
  await client.getByRole('button', { name: '接続画面を開く', exact: true }).click();
  const bridge = await popupPromise;
  await client.locator('#status').filter({ hasText: '423' }).waitFor();
  assert.equal(await client.locator('#result').textContent(), '');
  assert.equal(await bridge.evaluate(() => crossOriginIsolated), false);
  assert.ok(await bridge.evaluate(() => Boolean(window.opener)));
  await bridge.getByRole('button', { name: '連携を開始', exact: true }).click();
  await client.waitForTimeout(150);
  await client.locator('#read').click(); await client.locator('#status').filter({ hasText: '1件' }).waitFor();
  const result = JSON.parse(await client.locator('#result').textContent());
  assert.equal(result[0].name, '合成りんご'); assert.equal(result.length, 1); assert.doesNotMatch(JSON.stringify(result), /private|せっけん|memo|accountId/);
  assert.equal(await bridge.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await bridge.screenshot({ path: '../../docs/screenshots/food-bridge-light-375.png', fullPage: true });
  // The external app applies both deletion notices and later restoration using its saved cursor.
  await page.evaluate(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open('kakeimatch-local-data'); request.onsuccess = () => resolve(request.result); });
    const key = `${localStorage.getItem('kakeimatch.local-profile.v1')}\u0000receipt:synthetic-food`;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite'); const store = tx.objectStore('records'); const get = store.get(key);
      get.onsuccess = () => { const record = get.result; record.value.registration.status = 'deleted'; store.put(record); };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    }); db.close();
  });
  await client.waitForTimeout(150); await client.locator('#read').click(); await client.locator('#status').filter({ hasText: '0件' }).waitFor();
  assert.deepEqual(JSON.parse(await client.locator('#result').textContent()), []);
  await seed(foodCategoryId);
  await client.waitForTimeout(150); await client.locator('#read').click(); await client.locator('#status').filter({ hasText: '1件' }).waitFor();
  // Reject a different window and an incorrect origin even if the key is valid.
  await client.evaluate(() => {
    window.untrustedResponse = false;
    window.addEventListener('message', event => { if (event.data?.id === 'untrusted') window.untrustedResponse = true; });
  });
  await bridge.evaluate(({ token, origin }) => {
    const data = { type: 'kakeimatch.food.request', id: 'untrusted', token, method: 'GET', path: '/api/v1/food-purchases' };
    window.dispatchEvent(new MessageEvent('message', { origin, source: window, data }));
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://attacker.example', source: window.opener, data }));
  }, { token, origin: externalOrigin });
  await client.waitForTimeout(150);
  assert.equal(await client.evaluate(() => window.untrustedResponse), false);
  // Cross-tab relocking blocks an already authorized session.
  const salt = Buffer.alloc(16, 1);
  const config = { version: 1, pinSalt: salt.toString('base64'), pinHash: pbkdf2Sync('123456', salt, 120000, 32, 'sha256').toString('base64'), recoverySalt: salt.toString('base64'), recoveryHash: 'unused' };
  await page.evaluate(config => localStorage.setItem('kakeimatch.screen-lock.v1', JSON.stringify(config)), config);
  await bridge.locator('#screen-lock-overlay').waitFor();
  await client.locator('#read').click(); await client.locator('#status').filter({ hasText: '423' }).waitFor();
  await bridge.getByLabel('6桁のPIN', { exact: true }).fill('123456'); await bridge.getByRole('button', { name: 'ロックを解除', exact: true }).click();
  await bridge.locator('#screen-lock-overlay').waitFor({ state: 'hidden' });
  await bridge.getByRole('button', { name: '連携を開始', exact: true }).click();
  await client.waitForTimeout(150); await client.locator('#read').click(); await client.locator('#status').filter({ hasText: '1件' }).waitFor();
  await bridge.getByRole('button', { name: '連携を停止', exact: true }).click();
  await client.waitForTimeout(150); await client.locator('#read').click(); await client.locator('#status').filter({ hasText: '423' }).waitFor();
  await bridge.reload();
  await bridge.getByLabel('6桁のPIN', { exact: true }).fill('123456');
  await bridge.getByRole('button', { name: 'ロックを解除', exact: true }).click();
  // The ready notification may have arrived while locked; retry once to identify the app.
  await client.waitForTimeout(150); await client.locator('#read').click(); await client.locator('#status').filter({ hasText: '423' }).waitFor();
  await bridge.getByRole('button', { name: '連携を開始', exact: true }).click();
  await client.waitForTimeout(150); await client.locator('#read').click(); await client.locator('#status').filter({ hasText: '1件' }).waitFor();
  await page.getByRole('button', { name: '合成レシピアプリとの連携を解除', exact: true }).click();
  await client.waitForTimeout(150); await client.locator('#read').click(); await client.locator('#status').filter({ hasText: '401' }).waitFor();
  // The bridge keeps strict CSP and is never replaced by the cached main PWA shell.
  assert.equal((await context.request.get(`${app}/`)).headers()['cross-origin-opener-policy'], 'same-origin');
  const response = await context.request.get(`${app}/food-api.html`);
  assert.equal(response.headers()['cross-origin-opener-policy'], 'unsafe-none');
  assert.equal((await context.request.post(`${app}/food-api`)).status(), 405);
  assert.match(response.headers()['content-security-policy'], /frame-ancestors 'none'/);
  assert.deepEqual(errors, []);
  console.log('Food purchases cross-origin E2E passed: allow, read scope, screen lock, revoke, isolation.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
