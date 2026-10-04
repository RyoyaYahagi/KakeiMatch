import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a dedicated preview or local PWA.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const profiles = ['synthetic-profile-a', 'synthetic-profile-b'];
const timestamp = '2026-09-30T00:00:00.000Z';

async function seedV1(page) {
  await page.evaluate(async ({ profiles, timestamp }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('kakeimatch-local-data', 1);
      request.onupgradeneeded = () => {
        for (const name of ['records', 'blobs']) {
          const store = request.result.createObjectStore(name, { keyPath: 'key' });
          store.createIndex('profileId', 'profileId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(['records', 'blobs'], 'readwrite');
    const done = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error ?? new Error('seed transaction aborted'));
    });
    for (const profileId of profiles) {
      transaction.objectStore('records').put({
        key: `${profileId}\u0000receipt`, profileId, id: 'receipt', kind: 'receipt-metadata',
        value: { merchant: `Synthetic ${profileId}`, profileId }, updatedAt: timestamp,
      });
      transaction.objectStore('blobs').put({
        key: `${profileId}\u0000image`, profileId, id: 'image', ownerKind: 'receipt', ownerId: 'receipt',
        blob: new Blob([`synthetic image for ${profileId}`], { type: 'image/jpeg' }), contentType: 'image/jpeg', createdAt: timestamp,
      });
    }
    await done;
    db.close();
  }, { profiles, timestamp });
}

async function seedBeforeApp(context, page) {
  let intercepted = true;
  await context.route(url, async route => {
    if (!intercepted) return route.continue();
    intercepted = false;
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Seed</title>' });
  });
  await page.goto(url);
  await seedV1(page);
  await context.unroute(url);
}

async function inspectDatabase(page, expectedVersion, expectOwnerIndex) {
  return page.evaluate(async ({ expectedVersion, expectOwnerIndex, profiles }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('kakeimatch-local-data');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (db.version !== expectedVersion) throw new Error(`expected database version ${expectedVersion}, received ${db.version}`);
    const transaction = db.transaction(['records', 'blobs'], 'readonly');
    const hasOwnerIndex = transaction.objectStore('blobs').indexNames.contains('owner');
    if (expectOwnerIndex && JSON.stringify(transaction.objectStore('blobs').index('owner').keyPath) !== JSON.stringify(['profileId', 'ownerKind', 'ownerId'])) {
      throw new Error('unexpected owner index key path');
    }
    const records = await Promise.all(profiles.map(profileId => new Promise((resolve, reject) => {
      const request = transaction.objectStore('records').get(`${profileId}\u0000receipt`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })));
    const blobs = await Promise.all(profiles.map(profileId => new Promise((resolve, reject) => {
      const request = transaction.objectStore('blobs').get(`${profileId}\u0000image`);
      request.onsuccess = async () => {
        if (!request.result) return resolve(null);
        const { blob, ...metadata } = request.result;
        resolve({ ...metadata, size: blob.size, type: blob.type, text: await blob.text() });
      };
      request.onerror = () => reject(request.error);
    })));
    db.close();
    if (hasOwnerIndex !== expectOwnerIndex) throw new Error(`unexpected owner index state: ${hasOwnerIndex}`);
    return { records, blobs };
  }, { expectedVersion, expectOwnerIndex, profiles });
}

function assertPreserved(data) {
  assert.deepEqual(data.records, profiles.map(profileId => ({
    key: `${profileId}\u0000receipt`, profileId, id: 'receipt', kind: 'receipt-metadata',
    value: { merchant: `Synthetic ${profileId}`, profileId }, updatedAt: timestamp,
  })));
  assert.deepEqual(data.blobs, profiles.map(profileId => ({
    key: `${profileId}\u0000image`, profileId, id: 'image', ownerKind: 'receipt', ownerId: 'receipt',
    contentType: 'image/jpeg', createdAt: timestamp, size: new TextEncoder().encode(`synthetic image for ${profileId}`).length,
    type: 'image/jpeg', text: `synthetic image for ${profileId}`,
  })));
}

async function waitForHome(page) {
  await page.getByText('今月の支出 ¥0', { exact: true }).waitFor({ timeout: 15000 });
}

try {
  // Normal v1 -> v2 migration through the production app module in the built PWA.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await seedBeforeApp(context, page);
    await page.goto(url);
    await waitForHome(page);
    const data = await inspectDatabase(page, 2, true);
    assertPreserved(data);
    await context.close();
  }

  // Abort after the production migration has created its index and queued writes.
  // Chromium must roll back both the schema version and all rows; reload retries it.
  {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      const createIndex = IDBObjectStore.prototype.createIndex;
      IDBObjectStore.prototype.createIndex = function(name, ...args) {
        const index = createIndex.call(this, name, ...args);
        if (name === 'owner' && sessionStorage.getItem('synthetic-migration-failure') === 'yes') {
          sessionStorage.removeItem('synthetic-migration-failure');
          this.transaction.objectStore('records').clear();
          this.clear();
          throw new Error('synthetic browser migration failure');
        }
        return index;
      };
    });
    const page = await context.newPage();
    await seedBeforeApp(context, page);
    await page.evaluate(() => { sessionStorage.setItem('synthetic-migration-failure', 'yes'); });
    await page.goto(url);
    await page.getByText('端末内データの更新に失敗しました。更新前のデータは保持されています。他の画面を閉じ、再読み込みしてください。', { exact: true }).waitFor({ timeout: 15000 });
    const rolledBack = await inspectDatabase(page, 1, false);
    assertPreserved(rolledBack);

    await page.reload();
    await waitForHome(page);
    const retried = await inspectDatabase(page, 2, true);
    assertPreserved(retried);
    await context.close();
  }
  console.log('PASS: Chromium production PWA migrates synthetic v1 IndexedDB across profiles, rolls back an interrupted upgrade without data loss, and retries successfully.');
} finally {
  await browser.close();
}
