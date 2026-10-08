import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({ configFile: false, root: appRoot, logLevel: 'error',
  build: { write: false, minify: false, lib: { entry: resolve(appRoot, 'test/manual-retry.ts'), name: 'ManualRetry', formats: ['iife'] },
    rollupOptions: { external: ['@actual-app/api'] } } });
const output = Array.isArray(bundle) ? bundle.flatMap(item => item.output) : bundle.output;
const script = output.find(item => item.type === 'chunk').code;
const css = await readFile(resolve(appRoot, 'src/style.css'), 'utf8');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: `<meta charset="UTF-8"><style>${css}</style><main id="editor"></main>` }));
  await page.goto('http://localhost/manual-retry');
  await page.addScriptTag({ content: script });
  await page.locator('#manual-transaction-payee').fill('合成給与');
  await page.locator('#manual-transaction-amount').fill('12000');
  await page.locator('#manual-transaction-date').fill('2026-10-01');
  await page.locator('#manual-transaction-category').selectOption('income');
  await page.locator('#manual-transaction-account').selectOption('bank');
  await page.getByText('入力内容を端末に保存しました。', { exact: true }).waitFor();
  // Reopen a persisted draft, as after navigation or reloading.
  await page.evaluate(() => { document.querySelector('#editor').replaceChildren(); });
  await page.evaluate(() => window.manualRetry.open());
  await page.locator('#manual-transaction-payee').waitFor();
  await page.evaluate(() => { window.manualRetry.state.failReadback = true; });
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await page.getByRole('button', { name: '同じ内容で再試行する', exact: true }).waitFor();
  await page.evaluate(() => { document.querySelector('#editor').replaceChildren(); });
  await page.evaluate(() => window.manualRetry.open());
  await page.getByRole('button', { name: '同じ内容で再試行する', exact: true }).waitFor();
  if (process.env.PWA_MANUAL_RETRY_SCREENSHOT_PATH) {
    await mkdir(dirname(process.env.PWA_MANUAL_RETRY_SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: process.env.PWA_MANUAL_RETRY_SCREENSHOT_PATH });
  }
  await page.getByRole('button', { name: '同じ内容で再試行する', exact: true }).click();
  await page.waitForFunction(() => window.manualRetry.state.saves === 1).catch(async error => { console.log(await page.locator('[role=status]').innerText()); throw error; });
  assert.equal(await page.evaluate(() => window.manualRetry.rows.length), 1);
  assert.equal(await page.evaluate(() => window.manualRetry.records.size), 0);
  // A completed save leaves a fresh entry available. A cleanup failure must
  // recover the already saved row using the same imported ID after reopening.
  await page.evaluate(() => window.manualRetry.open());
  await page.locator('#manual-transaction-payee').waitFor();
  assert.equal(await page.locator('#manual-transaction-payee').inputValue(), '');
  assert.equal(await page.locator('#manual-transaction-amount').inputValue(), '');
  await page.locator('#manual-transaction-payee').fill('合成給与');
  await page.locator('#manual-transaction-amount').fill('15000');
  await page.locator('#manual-transaction-date').fill('2026-10-02');
  await page.locator('#manual-transaction-category').selectOption('income');
  await page.locator('#manual-transaction-account').selectOption('bank');
  await page.evaluate(() => { window.manualRetry.state.failCleanup = true; });
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await page.getByRole('button', { name: '同じ内容で再試行する', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.manualRetry.rows.length), 2);
  // An interrupted operation can leave processing rather than failed.
  await page.evaluate(() => {
    window.manualRetry.records.get('manual-draft:income:new').value.manualStatus = 'processing';
    document.querySelector('#editor').replaceChildren();
  });
  await page.evaluate(() => window.manualRetry.open());
  await page.getByRole('button', { name: '同じ内容で再試行する', exact: true }).click();
  await page.waitForFunction(() => window.manualRetry.state.saves === 2);
  assert.equal(await page.evaluate(() => window.manualRetry.rows.length), 2);
  assert.equal(await page.evaluate(() => window.manualRetry.records.size), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: failed/processing income drafts recover unknown writes and cleanup failures without duplicates, then allow a fresh entry');
} finally { await browser.close(); }
