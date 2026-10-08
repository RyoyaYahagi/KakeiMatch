import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Exercise the production renderers with synthetic records, without a household or API.
const cacheDir = await mkdtemp(join(tmpdir(), 'kakeimatch-record-totals-'));
const server = await createServer({ configFile: false, cacheDir, root: fileURLToPath(new URL('../../../', import.meta.url)), server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/synthetic-record-totals.html', route => route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/apps/pwa/src/style.css"><main id="records"></main><main id="search"></main>' }));
  await page.goto(`${server.resolvedUrls.local[0]}synthetic-record-totals.html`);
  const result = await page.evaluate(async () => {
    const { renderRecordGroups } = await import('/apps/pwa/src/records-list.ts');
    const { showTransactionSearch } = await import('/apps/pwa/src/local-transaction-search-ui.ts');
    const base = { date: '2026-10-01', categoryName: '食費', accountId: 'synthetic-wallet', cleared: false };
    const rows = [
      { ...base, id: 'expense', kind: 'expense', amountYen: -900, payeeName: 'Synthetic Purchase' },
      { ...base, id: 'excluded', kind: 'expense', amountYen: -3200, excludedFromSpending: true, payeeName: 'Synthetic Excluded' },
      { ...base, id: 'income', kind: 'income', amountYen: 1500, payeeName: 'Synthetic Income' },
      { ...base, id: 'refund', kind: 'expense', amountYen: 200, payeeName: 'Synthetic Refund' },
      { ...base, id: 'transfer', kind: 'transfer', amountYen: -5000, payeeName: 'Synthetic Transfer' },
      { ...base, date: '2026-09-30', id: 'excluded-only', kind: 'expense', amountYen: -100, excludedFromSpending: true, payeeName: 'Synthetic Excluded Only' },
    ];
    const target = document.querySelector('#records');
    const options = { filter: 'all', accountName: () => '合成データの口座', hasReceipt: () => false, needsReview: () => false, open: () => {} };
    const snapshot = () => ({ totals: [...target.querySelectorAll('.record-day-total')].map(node => node.textContent), count: target.querySelectorAll('.record-row').length });
    renderRecordGroups(target, rows, options);
    const all = snapshot();
    const excludedVisible = [...target.querySelectorAll('.record-note')].filter(node => node.textContent.includes('支出集計の対象外')).length;
    renderRecordGroups(target, rows, { ...options, filter: 'expense' });
    const expenses = snapshot();
    renderRecordGroups(target, rows, { ...options, filter: 'transfer' });
    const transfers = snapshot();
    rows[1].excludedFromSpending = false;
    renderRecordGroups(target, rows, options);
    const included = snapshot();
    rows[1].excludedFromSpending = true;
    renderRecordGroups(target, rows, options);
    await showTransactionSearch({ view: document.querySelector('#search'), loadEntries: async () => rows.map(transaction => ({ transaction, categoryIds: [], keywordValues: [] })),
      ledger: { listAccounts: async () => [], listCategories: async () => [] }, onTransaction: async () => {}, onBack: () => {}, onFiltersChange: () => {} });
    const search = { total: document.querySelector('.search-total').textContent, count: document.querySelector('#transaction-search-count').textContent };
    return { all, excludedVisible, expenses, transfers, included, search };
  });
  if (process.env.PWA_RECORD_TOTALS_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RECORD_TOTALS_SCREENSHOT_PATH, fullPage: true });
  assert.deepEqual(result.all, { totals: ['+¥800', ''], count: 6 });
  assert.equal(result.excludedVisible, 2);
  assert.deepEqual(result.expenses, { totals: ['−¥700', ''], count: 4 });
  assert.deepEqual(result.transfers, { totals: [''], count: 1 });
  assert.deepEqual(result.included, { totals: ['−¥2,400', ''], count: 6 });
  assert.deepEqual(result.search, { total: '+¥800', count: '6件' });
  for (const width of [375, 1024, 1440]) {
    await page.setViewportSize({ width, height: 812 });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px ${colorScheme}: no horizontal overflow`);
      assert.equal(await page.locator('.record-day-total').first().textContent(), '+¥800');
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS: daily and search totals exclude flagged records and transfers, retain rows, include refunds, and update after exclusion changes.');
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
