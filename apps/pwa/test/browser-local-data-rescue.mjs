import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a dedicated preview or local PWA.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 844 }, acceptDownloads: true });
const profileId = '00000000-0000-4000-8000-000000000001';
const page = await context.newPage();
await page.addInitScript(async ({ profileId }) => {
  localStorage.setItem('kakeimatch.local-profile.v1', profileId);
  navigator.serviceWorker.register = async () => ({});
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('kakeimatch-local-data', 3);
    request.onupgradeneeded = () => {
      for (const name of ['records', 'blobs']) request.result.createObjectStore(name, { keyPath: 'key' }).createIndex('profileId', 'profileId');
      request.result.createObjectStore('unrelated-credentials');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const tx = db.transaction(['records', 'blobs', 'unrelated-credentials'], 'readwrite');
  tx.objectStore('records').put({ key: `${profileId}\\0receipt`, profileId, id: 'receipt', kind: 'receipt-metadata', value: { merchant: 'Synthetic Market' }, updatedAt: '2026-09-30T00:00:00.000Z' });
  tx.objectStore('records').put({ key: `${profileId}\\0settings`, profileId, id: 'settings', kind: 'app-settings', value: { token: 'synthetic-cloud-token' }, updatedAt: '2026-09-30T00:00:00.000Z' });
  tx.objectStore('records').put({ key: 'other\\0receipt', profileId: 'other', id: 'foreign', kind: 'receipt-metadata', value: { merchant: 'Other profile' }, updatedAt: '2026-09-30T00:00:00.000Z' });
  tx.objectStore('blobs').put({ key: `${profileId}\\0image`, profileId, id: 'image', ownerKind: 'receipt', ownerId: 'receipt', blob: new Blob(['synthetic image'], { type: 'image/jpeg' }), contentType: 'image/jpeg', createdAt: '2026-09-30T00:00:00.000Z' });
  tx.objectStore('unrelated-credentials').put({ token: 'arbitrary-db-secret' }, 'secret');
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
  db.close();
}, { profileId });
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
try {
  await page.goto(url);
  await page.getByRole('heading', { name: '端末データの救出' }).waitFor();
  await page.getByText('この画面より新しい版の端末内データがあります。').waitFor();
  assert.equal(await page.locator('nav.app-nav').isVisible(), true, 'settings navigation must remain available for diagnostics');
  for (const id of ['home-tab', 'receipt-tab', 'add-record', 'reconciliation-tab']) {
    assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} must stay unavailable after startup fails`);
  }
  assert.equal(await page.locator('#household-view').isVisible(), false, 'stale household UI must stay unavailable after startup fails');
  await page.locator('#settings-tab').click();
  assert.equal(await page.locator('#settings-view').isVisible(), true, 'settings diagnostics must remain available after startup fails');
  if (process.env.PWA_RESCUE_SCREENSHOT_PATH) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#migration-rescue').screenshot({ path: process.env.PWA_RESCUE_SCREENSHOT_PATH });
  }
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '救出データを書き出す' }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /\.kmr$/);
  const downloadPath = await download.path();
  assert.ok(downloadPath);
  const rescue = JSON.parse(await readFile(downloadPath, 'utf8'));
  assert.equal(rescue.format, 'kakeimatch-local-rescue');
  assert.deepEqual(rescue.records.map(record => record.id), ['receipt']);
  assert.deepEqual(rescue.blobs.map(blob => blob.id), ['image']);
  assert.equal(rescue.manifest.skippedSensitiveRecords, 1);
  assert.match(rescue.manifest.warning, /Actual Budgetの家計簿を含みません/);
  assert.doesNotMatch(JSON.stringify(rescue), /synthetic-cloud-token|arbitrary-db-secret|Other profile/);
  const state = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('kakeimatch-local-data');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = { version: db.version, stores: [...db.objectStoreNames] };
    db.close();
    return result;
  });
  assert.equal(state.version, 3, 'rescue must not downgrade or migrate the existing database');
  assert.ok(state.stores.includes('unrelated-credentials'), 'rescue must not remove unknown stores');
  assert.deepEqual(pageErrors, []);
  console.log('PASS: future schema recovery export is read-only, limited to the active household profile and known stores, and clearly excludes Actual data.');
} finally { await browser.close(); }
