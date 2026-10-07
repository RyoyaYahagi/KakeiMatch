import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic test preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const page = await context.newPage();
const diagnosticRequests = [];
page.on('request', request => { if (request.method() === 'POST' && request.postData()?.includes('kakeimatch-diagnostics')) diagnosticRequests.push(request.url()); });
const preview = page.locator('#diagnostics-preview');
const readReport = async () => JSON.parse(await preview.textContent());
const open = async () => {
  await page.locator('#settings-tab').click(); await page.getByRole('button', { name: 'アプリ情報', exact: true }).click();
  await page.locator('#local-diagnostics summary').click();
  await page.waitForFunction(() => document.querySelector('#diagnostics-preview')?.textContent?.startsWith('{'));
};
try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.waitForFunction(() => document.querySelector('#message')?.textContent !== '家計簿を準備しています…');
  await open();
  assert.ok((await readReport()).entries.some(entry => entry.feature === 'startup' && entry.outcome === 'success'));
  const profile = await page.evaluate(() => localStorage.getItem('kakeimatch.local-profile.v1'));
  await context.setOffline(true);
  await page.locator('#diagnostics-refresh').click();
  assert.equal((await readReport()).network, 'offline');
  const snapshot = await preview.textContent();
  // A later failure must not change the report the user already reviewed.
  await page.evaluate(() => { window.dispatchEvent(new Event('error')); });
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#diagnostics-export').click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'kakeimatch-diagnostics.json');
  assert.equal(await readFile(await download.path(), 'utf8'), snapshot);
  await page.locator('#diagnostics-copy').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), snapshot);
  await page.locator('#diagnostics-refresh').click();
  assert.ok((await readReport()).entries.some(entry => entry.feature === 'runtime' && entry.outcome === 'failure'));
  await page.locator('#diagnostics-clear').click();
  assert.deepEqual((await readReport()).entries, []);
  assert.equal(await page.evaluate(() => localStorage.getItem('kakeimatch.local-profile.v1')), profile);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.PWA_DIAGNOSTICS_SCREENSHOT_PATH) await page.locator('#local-diagnostics').screenshot({ path: process.env.PWA_DIAGNOSTICS_SCREENSHOT_PATH });
  await context.setOffline(false);
  // Invalid archives leave a fixed restore failure and retain the original profile.
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#backup-file').setInputFiles({ name: 'synthetic-private-filename.kmb', mimeType: 'application/octet-stream', buffer: Buffer.from('synthetic-private-content') });
  await page.waitForFunction(() => !document.querySelector('#backup-settings')?.hasAttribute('inert'));
  await page.locator('#diagnostics-refresh').click();
  assert.ok((await readReport()).entries.some(entry => entry.feature === 'restore' && entry.outcome === 'failure'));
  assert.equal((await preview.textContent()).includes('synthetic-private'), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('kakeimatch.local-profile.v1')), profile);
  assert.deepEqual(diagnosticRequests, []);
  // A future schema blocks household initialization but settings/diagnostics remain available.
  const future = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await future.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
  const futurePage = await future.newPage();
  await futurePage.goto(process.env.PWA_E2E_URL);
  await futurePage.waitForFunction(() => document.querySelector('#message')?.textContent !== '家計簿を準備しています…');
  await futurePage.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('kakeimatch-local-data', 99);
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
  });
  await futurePage.reload();
  await futurePage.getByText('この画面より新しい版の端末内データがあります。', { exact: false }).waitFor();
  await futurePage.locator('#settings-tab').click(); await futurePage.getByRole('button', { name: 'アプリ情報', exact: true }).click();
  await futurePage.locator('#local-diagnostics summary').click();
  await futurePage.waitForFunction(() => document.querySelector('#diagnostics-preview')?.textContent?.startsWith('{'));
  const futureReport = JSON.parse(await futurePage.locator('#diagnostics-preview').textContent());
  assert.ok(futureReport.entries.some(entry => entry.feature === 'migration' && entry.code === 'future_schema'));
  console.log('PASS: offline reviewed copy/export, safe restore failure, bounded diagnostics clearing, 375px, preserved profile, future-schema startup recovery and no automatic diagnostic upload.');
} finally { await browser.close(); }
