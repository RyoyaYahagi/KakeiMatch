import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a dedicated preview or local PWA.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
await context.addInitScript(() => {
  if (!sessionStorage.getItem('synthetic-enable-offline')) {
    window.syntheticRegisterOffline = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = async () => ({});
  }
});
const page = await context.newPage();
// Keep monthly totals aligned with the synthetic receipts, regardless of the run date.
await page.clock.setFixedTime(new Date('2026-09-30T03:00:00Z'));
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') console.log('Browser error', message.text()); });
page.on('requestfailed', request => console.log('Failed request', new URL(request.url()).pathname, request.failure()?.errorText));

const syntheticPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64');
const headers = '利用日/キャンセル日,利用店名・商品名,利用者,決済方法,支払区分,利用金額,手数料,支払総額,当月支払金額,翌月以降繰越金額,調整額,当月お支払日';
const csv = `${headers}\n2026/09/30,Synthetic Corner,Synthetic User,PayPayクレジット,1回,1280,0,1280,1280,0,0,2026/10/27\n2026/09/30,Synthetic Unmatched,Synthetic User,PayPayクレジット,1回,500,0,500,500,0,0,2026/10/27\n`;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object' && !(value instanceof Blob)) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

async function readHouseholdSnapshot() {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('kakeimatch-local-data');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction(['records', 'blobs'], 'readonly');
      const recordsRequest = tx.objectStore('records').getAll();
      const blobsRequest = tx.objectStore('blobs').getAll();
      const [records, blobs] = await Promise.all([
        new Promise((resolve, reject) => { recordsRequest.onsuccess = () => resolve(recordsRequest.result); recordsRequest.onerror = () => reject(recordsRequest.error); }),
        new Promise((resolve, reject) => { blobsRequest.onsuccess = () => resolve(blobsRequest.result); blobsRequest.onerror = () => reject(blobsRequest.error); }),
      ]);
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
      const currentProfile = localStorage.getItem('kakeimatch.local-profile.v1');
      const ownedRecords = records.filter(row => row.profileId === currentProfile)
        .map(row => { const copy = { ...row }; delete copy.key; delete copy.profileId; return copy; })
        // These IDs are scoped to the device's Actual budget ID, which changes on restore.
        .filter(row => row.id !== 'settings:budget' && !row.id.startsWith('settings:basic-categories:'))
        .sort((a, b) => a.id.localeCompare(b.id));
      const ownedBlobs = await Promise.all(blobs.filter(row => row.profileId === currentProfile).map(async row => {
        const copy = { ...row };
        delete copy.key; delete copy.profileId;
        const blob = copy.blob;
        delete copy.blob;
        return {
          ...copy, size: blob.size, type: blob.type,
          sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join(''),
        };
      }));
      ownedBlobs.sort((a, b) => a.id.localeCompare(b.id));
      return { records: ownedRecords, blobs: ownedBlobs };
    } finally { db.close(); }
  }).then(stable);
}

async function readProfileRecords() {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('kakeimatch-local-data');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const profileId = localStorage.getItem('kakeimatch.local-profile.v1');
      const tx = db.transaction('records', 'readonly');
      return await new Promise((resolve, reject) => {
        const request = tx.objectStore('records').index('profileId').getAll(profileId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
}

async function waitForProfileRecords(predicate, description) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const records = await readProfileRecords();
    if (predicate(records)) return records;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for ${description}. Last local records: ${JSON.stringify(await readProfileRecords())}`);
}

async function waitForReady() {
  await page.waitForFunction(() => document.querySelector('#home-summary')?.getAttribute('aria-busy') === 'false');
}

async function setupLedger() {
  await page.locator('#settings-tab').click();
  await page.getByRole('button', { name: '支払元', exact: true }).click();
  await page.getByRole('button', { name: '支払元を追加する', exact: true }).click();
  await page.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Backup Wallet');
  await page.getByRole('button', { name: '追加する', exact: true }).click();
  await page.getByRole('button', { name: 'Synthetic Backup Wallet · 利用中', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Synthetic Backup Wallet · 利用中', exact: true }).click();
  await page.getByRole('button', { name: '編集する', exact: true }).click();
  await page.locator('select[name="accountType"]').selectOption('other');
  await page.locator('select[name="statementProvider"]').selectOption('paypay_card');
  await page.getByRole('button', { name: '変更を保存', exact: true }).click();
  await page.locator('[data-detail="明細サービス"] dd').getByText('PayPayカード', { exact: true }).waitFor();
  await page.locator('#settings-tab').click();
  await page.getByRole('button', { name: 'カテゴリ', exact: true }).click();
  // A default category deleted by the user must stay deleted after a restore.
  await page.getByRole('button', { name: /^外食 ·/ }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'カテゴリを削除する', exact: true }).click();
  await page.getByRole('button', { name: 'カテゴリを追加する', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^外食 ·/ }).count(), 0);
}

async function assertDeletedDefaultCategoryAbsent() {
  await page.locator('#settings-tab').click();
  await page.getByRole('button', { name: 'カテゴリ', exact: true }).click();
  await page.getByRole('button', { name: /^食費 ·/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^外食 ·/ }).count(), 0, 'restore must not recreate a deleted default category');
  await page.locator('#home-tab').click();
  await waitForReady();
}

async function addReceipt(merchant, amount) {
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: '記録を追加', exact: true }).click();
  const fileInputs = page.locator('#record-sheet input[type=file]');
  await fileInputs.first().setInputFiles({ name: `${merchant}.png`, mimeType: 'image/png', buffer: syntheticPng });
  await page.locator('#receipt-merchant').waitFor();
  await page.waitForFunction(() => document.querySelector('#receipt-category')?.options.length > 1 && document.querySelector('#receipt-account')?.options.length > 1);
  await page.locator('#receipt-merchant').fill(merchant);
  await page.locator('#receipt-date').fill('2026-09-30');
  await page.locator('#receipt-amount').fill(String(amount));
  await page.locator('#receipt-category').selectOption({ label: '食費' });
  await page.locator('#receipt-account').selectOption({ label: 'Synthetic Backup Wallet' });
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  try { await page.getByText('登録しました。', { exact: true }).waitFor({ timeout: 15000 }); }
  catch (error) {
    const diagnostic = await page.evaluate(() => ({
      message: document.querySelector('#message')?.textContent,
      values: ['receipt-merchant', 'receipt-date', 'receipt-amount', 'receipt-category', 'receipt-account'].map(id => [id, document.getElementById(id)?.value]),
      formValid: document.querySelector('#local-view form')?.checkValidity(),
    }));
    throw new Error(`Synthetic receipt registration failed: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
}

async function importStatementCsv() {
  const reconciliationTab = page.locator('#reconciliation-tab');
  if (await reconciliationTab.getAttribute('aria-pressed') !== 'true') {
    await reconciliationTab.click();
    await page.waitForFunction(() => document.querySelector('#reconciliation-tab')?.getAttribute('aria-pressed') === 'true');
  }
  await page.locator('#statement-provider').waitFor({ state: 'attached' });
  const importerSummary = page.locator('summary').filter({ hasText: '明細CSVを取り込む' });
  if (await importerSummary.count()) await importerSummary.evaluate(node => { const disclosure = node.closest('details'); if (disclosure) disclosure.open = true; });
  await page.locator('#statement-provider').waitFor({ state: 'visible' });
  await page.locator('#statement-provider').selectOption('paypay_card');
  await page.locator('#statement-file').setInputFiles({ name: 'synthetic-paypay-card.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: '取り込んで照合', exact: true }).click();
  await page.getByText('2件を取り込み、照合しました。重複 0件。対象外 0件、要確認 0件。', { exact: true }).waitFor();
  await page.getByText(/自動で一致 0件 · 要確認 1件 · 記録なし 1件/).waitFor();
}

async function seedAuditAndPreferences() {
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('kakeimatch-local-data');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction('records', 'readwrite');
      const store = tx.objectStore('records');
      const profileId = localStorage.getItem('kakeimatch.local-profile.v1');
      const rows = await new Promise((resolve, reject) => {
        const request = store.index('profileId').getAll(profileId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const receiptRecords = rows.filter(row => row.kind === 'receipt-metadata' && row.value.registration.status === 'applied');
      const statementRecords = rows.filter(row => row.kind === 'statement-transaction');
      const runRecord = rows.filter(row => row.kind === 'reconciliation-run').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (receiptRecords.length < 2 || statementRecords.length < 2 || !runRecord) throw new Error('Expected synthetic receipts, canonical statements, and a reconciliation run.');
      const statementRecord = statementRecords.find(row => row.value.merchant === 'Synthetic Corner' && row.value.amountYen === 1280);
      const chosenReceiptRecord = receiptRecords.find(row => row.value.confirmedValue.merchant === 'Synthetic Corner Market');
      const rejectedReceiptRecord = receiptRecords.find(row => row.value.confirmedValue.merchant === 'Synthetic Corner');
      if (!statementRecord || !chosenReceiptRecord || !rejectedReceiptRecord) throw new Error('Expected the synthetic ambiguous candidate pair.');
      const statement = statementRecord.value;
      const chosenReceipt = chosenReceiptRecord.value;
      const timestamp = new Date().toISOString();
      const runId = runRecord.value.runId;
      const existingResolution = rows.find(row => row.kind === 'reconciliation-resolution' && row.value.statementId === statement.id && row.value.receiptId === chosenReceipt.id && row.value.source === 'user');
      const alias = rows.find(row => row.kind === 'merchant-mapping' && row.value.aliasMerchant === chosenReceipt.confirmedValue.merchant);
      if (!existingResolution || !alias) throw new Error(`Missing user resolution or merchant mapping from the reconciliation UI: ${JSON.stringify({ statementId: statement.id, receiptId: chosenReceipt.id, resolutions: rows.filter(row => row.kind === 'reconciliation-resolution').map(row => row.value), aliases: rows.filter(row => row.kind === 'merchant-mapping').map(row => row.value) })}`);
      const correctionId = `reconciliation-pair-rejection:${runId}:${encodeURIComponent(statement.id)}:${encodeURIComponent(rejectedReceiptRecord.value.id)}`;
      const correction = { runId, statementId: statement.id, receiptId: rejectedReceiptRecord.value.id };
      store.put({ id: correctionId, kind: 'correction-audit', value: correction, updatedAt: timestamp, profileId, key: `${profileId}\0${correctionId}` });
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    } finally { db.close(); }
  });
}

async function exportBackup() {
  await page.locator('#settings-tab').click();
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#backup-export').click();
  let download;
  try { download = await downloadPromise; }
  catch (error) {
    const status = await page.locator('#backup-settings [role=status]').innerText().catch(() => '');
    throw new Error(`Backup export did not download: ${status || 'no status message'}`, { cause: error });
  }
  await page.waitForFunction(() => {
    const section = document.querySelector('#backup-settings');
    return !section?.hasAttribute('inert')
      && section?.querySelector('[role="status"]')?.textContent === 'バックアップを生成しました。Filesなどへの保存を確認してください。';
  });
  assert.match(download.suggestedFilename(), /\.kmb$/i);
  const path = await download.path();
  if (!path) throw new Error('Backup download was not materialized.');
  // The download event can fire before the export action clears its inert/running state.
  await page.getByText('バックアップを生成しました。Filesなどへの保存を確認してください。', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#backup-settings')?.hasAttribute('inert'));
  const { readFile } = await import('node:fs/promises');
  // The download starts before the export finishes; a restore chosen meanwhile is ignored as a concurrent operation.
  await page.getByText('バックアップを生成しました。Filesなどへの保存を確認してください。', { exact: true }).waitFor();
  return readFile(path);
}

async function importBackup(buffer, filename = 'synthetic.kmb') {
  await page.locator('#settings-tab').click();
  const navigation = page.waitForNavigation({ waitUntil: 'load' });
  const confirmationPromise = page.waitForEvent('dialog');
  const fileSelection = page.locator('#backup-file').setInputFiles({ name: filename, mimeType: 'application/vnd.kakeimatch.backup', buffer });
  const confirmation = await confirmationPromise;
  assert.equal(confirmation.type(), 'confirm');
  await confirmation.accept();
  await fileSelection;
  await navigation;
  await waitForReady();
}

async function exportSnapshot() {
  const transactions = await page.locator('#transactions li').evaluateAll(items => items.map(item => {
    const fields = Array.from(item.children).map(child => child.textContent?.trim() ?? '').filter(Boolean);
    return fields.length ? fields.join(' ') : item.textContent?.trim() ?? '';
  }));
  const summary = await page.locator('.monthly-totals > div').evaluateAll(rows => rows.map(row => row.textContent?.replace(/\s+/g, ' ').trim() ?? ''));
  return { data: await readHouseholdSnapshot(), renderedTransactions: transactions, renderedSummary: summary };
}

function assertPayPayCardStatementMapping(snapshot) {
  const imports = snapshot.data.records.filter(row => row.kind === 'statement-import' && row.value.provider === 'paypay_card');
  assert.equal(imports.length, 1, 'backup should preserve the mapped PayPay Card import');
  const imported = imports[0].value;
  assert.equal(imported.accountId, undefined, 'a provider-only statement import should not record a payment source');
  const accountMapping = snapshot.data.records.find(row => row.kind === 'account-metadata' && row.value.statementProvider === 'paypay_card');
  assert.ok(accountMapping, 'backup should retain the optional account-to-provider metadata');
}

async function wipeLocalData() {
  const navigation = page.waitForNavigation({ waitUntil: 'load' });
  page.once('dialog', async dialog => {
    assert.equal(dialog.type(), 'confirm');
    const promptPromise = page.waitForEvent('dialog');
    await dialog.accept();
    const prompt = await promptPromise;
    assert.equal(prompt.type(), 'prompt');
    assert.match(prompt.message(), /すべて削除/);
    await prompt.accept('すべて削除');
  });
  await page.getByRole('button', { name: '原本の整理・全削除', exact: true }).click(); await page.locator('#local-wipe').click();
  await navigation;
}

try {
  await page.goto(url);
  await waitForReady();
  await setupLedger();
  await addReceipt('Synthetic Corner', 1280);
  await addReceipt('Synthetic Corner Market', 1280);
  await importStatementCsv();
  await page.getByText(/要確認 1件/).waitFor();
  await page.locator('details.review-item').filter({ has: page.locator('summary .record-title', { hasText: 'Synthetic Corner' }) }).locator('summary').click();
  await page.locator('.compare-candidate').filter({ has: page.locator('.slip-record', { hasText: 'Synthetic Corner Market' }) }).getByRole('button', { name: '同じ支出', exact: true }).click();
  await waitForProfileRecords(rows => rows.some(row => row.kind === 'reconciliation-resolution' && row.value.source === 'user' && row.value.status === 'applied') &&
    rows.some(row => row.kind === 'merchant-mapping' && row.value.aliasMerchant === 'Synthetic Corner Market'), 'applied user resolution and merchant alias');
  await seedAuditAndPreferences();
  await page.locator('#home-tab').click();
  await waitForReady();

  // Prime the backup timestamp; the next archive must carry that saved setting.
  await exportBackup();
  const sourceSnapshot = await exportSnapshot();
  assertPayPayCardStatementMapping(sourceSnapshot);
  const originalBackup = await exportBackup();
  assert.ok(originalBackup.byteLength > 64, 'portable backup should contain Actual and local data');

  // Verify corrupt input fails before either Actual or KakeiMatch data is changed.
  const beforeCorruptImport = await exportSnapshot();
  const corrupt = Buffer.from(originalBackup);
  corrupt[corrupt.length - 1] ^= 0xff;
  await page.locator('#settings-tab').click();
  const corruptConfirmationPromise = page.waitForEvent('dialog');
  const corruptFileSelection = page.locator('#backup-file').setInputFiles({ name: 'synthetic-corrupt.kmb', mimeType: 'application/vnd.kakeimatch.backup', buffer: corrupt });
  const corruptConfirmation = await corruptConfirmationPromise;
  await corruptConfirmation.accept();
  await corruptFileSelection;
  await page.getByText(/バックアップを読み込めませんでした|チェックサム|破損/).waitFor({ timeout: 10000 });
  assert.deepEqual(await exportSnapshot(), beforeCorruptImport, 'corrupt import must leave the active profile and Actual transactions intact');

  await importBackup(originalBackup);
  await page.reload();
  await waitForReady();
  const restoredSnapshot = await exportSnapshot();
  assertPayPayCardStatementMapping(restoredSnapshot);
  assert.deepEqual(restoredSnapshot, sourceSnapshot, 'restored KakeiMatch records and rendered Actual transactions should match');
  await assertDeletedDefaultCategoryAbsent();
  assert.equal(await page.locator('#restore-previous').isEnabled(), true, 'successful import should preserve a return path to the previous profile');
  await page.locator('#settings-tab').click(); await page.getByRole('button', { name: '家計簿の読み込み・切り替え', exact: true }).click();
  const returnNavigation = page.waitForNavigation({ waitUntil: 'load' });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#restore-previous').click();
  await returnNavigation;
  await waitForReady();
  const previousSnapshot = await exportSnapshot();
  assert.deepEqual(previousSnapshot, beforeCorruptImport, 'the prior profile should still be intact and selectable after staging restore');
  await page.locator('#settings-tab').click(); await page.getByRole('button', { name: '家計簿の読み込み・切り替え', exact: true }).click();
  const restoreNavigation = page.waitForNavigation({ waitUntil: 'load' });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#restore-previous').click();
  await restoreNavigation;
  await waitForReady();
  assert.deepEqual(await exportSnapshot(), restoredSnapshot, 'returning again should switch back to the imported profile');

  // Cleanup removes only image/CSV blobs; canonical rows and decisions remain.
  await page.locator('#settings-tab').click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '原本の整理・全削除', exact: true }).click(); await page.locator('#receipt-image-cleanup').click();
  await page.waitForFunction(message => document.querySelector('#backup-cleanup-tools [role=status]')?.textContent?.includes(message), '2件のレシート画像を削除しました。');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#statement-csv-cleanup').click();
  await page.waitForFunction(message => document.querySelector('#backup-cleanup-tools [role=status]')?.textContent?.includes(message), '1件のCSV原本を削除しました。');
  await page.locator('#home-tab').click();
  await waitForReady();
  const cleanedSnapshot = await exportSnapshot();
  assert.equal(cleanedSnapshot.data.blobs.length, 0, 'cleanup should remove both receipt images and CSV source blobs');
  assert.deepEqual(cleanedSnapshot.data.records, sourceSnapshot.data.records, 'cleanup must preserve all structured, canonical, decision, mapping, and settings records');
  assert.deepEqual(cleanedSnapshot.renderedTransactions, sourceSnapshot.renderedTransactions, 'Actual ledger transactions should survive raw artifact cleanup');

  const noRawBackup = await exportBackup();
  assert.ok(noRawBackup.byteLength > 64, 'backup should remain possible after raw artifacts are removed');
  await importBackup(noRawBackup, 'synthetic-without-raw-artifacts.kmb');
  await page.reload();
  await waitForReady();
  const noRawRestored = await exportSnapshot();
  assertPayPayCardStatementMapping(noRawRestored);
  assert.deepEqual(noRawRestored.data.records, cleanedSnapshot.data.records);
  assert.equal(noRawRestored.data.blobs.length, 0);
  assert.deepEqual(noRawRestored.renderedTransactions, cleanedSnapshot.renderedTransactions);

  // The profile is deliberately signed out in this fresh browser context.
  await page.locator('#settings-tab').click(); await page.getByRole('button', { name: 'ログイン・利用状況', exact: true }).click();
  await page.getByText(/未ログイン|AIアカウントへ接続できません/).waitFor();
  await page.locator('#settings-tab').click();
  // Synthetic unresolved-import marker: new imports must stop even if the public list is empty.
  const incompleteKey = 'kakeimatch.incomplete-actual-restore.v1';
  const profileBeforeGuard = await page.evaluate(() => localStorage.getItem('kakeimatch.local-profile.v1'));
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify(['/kakeimatch-restore/synthetic-incomplete'])), incompleteKey);
  await page.locator('#settings-tab').click();
  await page.waitForFunction(() => document.querySelector('#backup-import')?.disabled === true);
  assert.ok((await exportBackup()).byteLength > 64, 'an unresolved restore must not prevent exporting the active household');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#backup-file').setInputFiles({ name: 'synthetic-blocked-retry.kmb', mimeType: 'application/octet-stream', buffer: Buffer.from(noRawBackup) });
  await page.getByText(/新しい復元を開始できません/).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('kakeimatch.local-profile.v1')), profileBeforeGuard);
  await page.reload(); await waitForReady(); await page.locator('#settings-tab').click();
  await page.waitForFunction(() => document.querySelector('#backup-import')?.disabled === true);
  assert.ok((await exportBackup()).byteLength > 64, 'export remains available after restarting with the marker');
  if (process.env.PWA_RESTORE_GUARD_SCREENSHOT_PATH) await page.locator('#backup-settings').screenshot({ path: process.env.PWA_RESTORE_GUARD_SCREENSHOT_PATH });
  // Remove the marker only in this synthetic test to resume the existing full-wipe regression.
  // Production intentionally has no API to declare unenumerable Actual data clean.
  await page.evaluate(key => localStorage.removeItem(key), incompleteKey);
  if (process.env.PWA_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_SCREENSHOT_PATH, fullPage: true });
  await wipeLocalData();
  await waitForReady();
  const wiped = await readHouseholdSnapshot();
  assert.deepEqual(wiped, { records: [], blobs: [] }, 'local full wipe must clear household IndexedDB data while signed out');
  await page.getByText('まだ記録がありません。').waitFor();

  assert.deepEqual(pageErrors, []);
  console.log('PASS: actual browser-ledger export/import, staging restore after local wipe, corruption safety, receipt/CSV cleanup, missing-raw round-trip, and signed-out local full wipe.');
} catch (error) {
  console.error(await page.locator('body').innerText().catch(() => 'Page unavailable'));
  console.error('Page errors:', pageErrors);
  throw error;
} finally {
  await browser.close();
}
