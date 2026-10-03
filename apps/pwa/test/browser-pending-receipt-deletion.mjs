import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic test preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.locator('#receipt-tab').click();
  await page.waitForFunction(() => document.querySelector('#local-view')?.hidden === false);
  await page.evaluate(async () => {
    const profileId = localStorage.getItem('kakeimatch.local-profile.v1');
    if (!profileId) throw new Error('Synthetic local profile was not initialized.');
    const id = 'receipt:issue-150-synthetic';
    const blobId = 'receipt-image:issue-150-synthetic';
    const timestamp = '2026-10-03T00:00:00.000Z';
    const receipt = {
      id, createdAt: timestamp, updatedAt: timestamp,
      image: { blobId, contentType: 'image/png', sizeBytes: 9 }, extraction: null,
      aiSuggestion: { categoryId: null, source: 'unclassified', probabilities: null, model: null, attemptedAt: null },
      confirmedValue: null, registration: { status: 'pending', actualTransactionId: null, lastError: null },
    };
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('kakeimatch-local-data');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(['records', 'blobs'], 'readwrite');
      transaction.objectStore('records').put({ id, kind: 'receipt-metadata', value: receipt, updatedAt: timestamp, profileId, key: `${profileId}\u0000${id}` });
      transaction.objectStore('blobs').put({ id: blobId, ownerKind: 'receipt', ownerId: id, blob: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])], { type: 'image/png' }), contentType: 'image/png', createdAt: timestamp, profileId, key: `${profileId}\u0000${blobId}` });
      transaction.oncomplete = resolve;
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Synthetic data setup failed.'));
    });
    database.close();
  });
  await page.reload();
  await page.locator('#receipt-tab').click();
  await page.getByRole('heading', { name: '確認待ち 1件' }).waitFor();
  const remove = page.getByRole('button', { name: '削除: 未入力のレシート', exact: true });
  const expectsDelete = process.env.PWA_EXPECT_DELETE !== 'false';
  assert.equal(await remove.count(), expectsDelete ? 1 : 0);
  if (process.env.PWA_PENDING_RECEIPT_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_PENDING_RECEIPT_SCREENSHOT_PATH, fullPage: true });
  if (expectsDelete) {
    let dialogs = 0;
    page.once('dialog', async dialog => { dialogs += 1; await dialog.dismiss(); });
    await remove.click();
    await page.getByRole('heading', { name: '確認待ち 1件' }).waitFor();
    assert.equal(await remove.count(), 1, 'dismissing confirmation should keep the receipt');

    await page.evaluate(() => {
      if (navigator.locks) Object.defineProperty(navigator.locks, 'request', { configurable: true, value: () => Promise.reject(new Error('synthetic deletion failure')) });
    });
    page.once('dialog', async dialog => { dialogs += 1; await dialog.accept(); });
    await remove.click();
    await page.getByText('操作を完了できませんでした。保存済みのデータを確認して再試行してください。', { exact: true }).waitFor();
    assert.equal(await remove.count(), 1, 'failed deletion should keep the receipt and its control');
    assert.equal(await remove.isEnabled(), true, 'failed deletion should allow retry');
    await page.evaluate(() => { if (navigator.locks) delete navigator.locks.request; });

    page.on('dialog', async dialog => { dialogs += 1; await dialog.accept(); });
    await remove.evaluate(button => { button.click(); button.click(); });
    await page.getByText('まだ記録がありません。', { exact: true }).waitFor();
    assert.equal(dialogs, 3, 'cancel, failed request, and double submission should open exactly three confirmations');
    await page.reload();
    await page.locator('#receipt-tab').click();
    await page.getByText('まだ記録がありません。', { exact: true }).waitFor();
    const reads = await page.evaluate(async () => {
      const profileId = localStorage.getItem('kakeimatch.local-profile.v1');
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('kakeimatch-local-data');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(['records', 'blobs']);
        const receipt = transaction.objectStore('records').get(`${profileId}\u0000receipt:issue-150-synthetic`);
        const image = transaction.objectStore('blobs').get(`${profileId}\u0000receipt-image:issue-150-synthetic`);
        transaction.oncomplete = () => { database.close(); resolve({ receipt: receipt.result, image: image.result }); };
        transaction.onerror = () => reject(transaction.error);
      });
    });
    assert.equal(reads.receipt, undefined);
    assert.equal(reads.image, undefined);
  }
  assert.deepEqual(errors, []);
  console.log(`PASS: ${expectsDelete ? 'pending receipt deletion and reload persistence' : 'pre-change pending receipt screen'} at 375px; screenshot saved`);
} catch (error) {
  console.log(await page.locator('body').innerText().catch(() => ''));
  throw error;
} finally {
  await browser.close();
}
