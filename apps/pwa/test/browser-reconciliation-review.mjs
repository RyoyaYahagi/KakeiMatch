import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { waitForBackupExportReady } from './backup-e2e-helpers.mjs';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to a dedicated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
async function press(locator) {
  const handle = await locator.elementHandle();
  await locator.click();
  // The action may replace the entire screen. Wait on the original button's completion.
  await page.waitForFunction(node => !node.disabled, handle); await handle.dispose();
}
const click = name => press(page.getByRole('button', { name, exact: true }));
async function readyHome() {
  await page.locator('#local-settings .master-entry[aria-label="支払元"]').waitFor({ state: 'attached' });
  await page.locator('#home-tab').click();
  await page.waitForFunction(() => document.querySelector('#home-summary')?.getAttribute('aria-busy') === 'false');
  await page.getByText('今月の支出 ¥0', { exact: true }).waitFor();
}

async function createAccount(name, type, provider) {
  await page.locator('#settings-tab').click(); await click('支払元'); await click('支払元を追加する');
  await page.locator('select[name="accountType"]').selectOption(type);
  await page.getByLabel('支払元の名前', { exact: true }).fill(name); await click('追加する');
  const account = page.getByRole('button', { name: `${name} · 利用中`, exact: true }); await account.waitFor();
  if (provider) {
    await account.click(); await click('編集する');
    await page.locator('select[name="accountType"]').selectOption(type);
    await page.locator('select[name="statementProvider"]').selectOption(provider);
    await click('変更を保存');
    await page.locator('[data-detail="明細サービス"] dd').getByText(`${({ paypay_card: 'PayPayカード', smbc_card: '三井住友カード', rakuten_card: '楽天カード' })[provider]}`, { exact: true }).waitFor();
  }
}

// Seed synthetic transactions through the production Actual browser API. The flow under
// test starts at reconciliation; unrelated manual-entry forms have their own E2E suite.
async function addExpense(merchant, amount, category, account) {
  await page.evaluate(async ({ merchant, amount, category, account }) => {
    const url = performance.getEntriesByType('resource').find(entry => /\/assets\/browser-[^/]+\.js$/.test(entry.name))?.name;
    if (!url) throw new Error('Actual browser module was not loaded');
    const api = await import(url);
    const accountId = (await api.getAccounts()).find(row => row.name === account)?.id;
    const categoryId = (await api.getCategories()).find(row => row.name === category)?.id;
    if (!accountId || !categoryId) throw new Error('Synthetic account or category missing');
    await api.importTransactions(accountId, [{ date: '2026-09-30', amount: -amount, payee_name: merchant, category: categoryId,
      imported_id: `synthetic-review:${merchant}`, cleared: false }]);
  }, { merchant, amount, category, account });
}

const headers = '利用日/キャンセル日,利用店名・商品名,利用者,決済方法,支払区分,利用金額,手数料,支払総額,当月支払金額,翌月以降繰越金額,調整額,当月お支払日';
const csv = extra => `${headers}\n${[
  [1200, 'Synthetic Automatic'], [500, 'Synthetic Manual'], [3000, 'Synthetic Unknown'], ...extra,
].map(([amount, merchant]) => `2026/09/30,${merchant},Synthetic User,PayPayクレジット,1回,${amount},0,${amount},${amount},0,0,2026/10/27`).join('\n')}\n`;
const pending = merchant => page.locator('#reconciliation-pending .review-item').filter({ hasText: merchant });
const matched = merchant => page.locator('#reconciliation-matched li > details').filter({ hasText: merchant });
const suspected = () => page.locator('#reconciliation-suspected li > details');
async function importCsv(extra = []) {
  const disclosure = page.locator('.statement-import-disclosure'); if (await disclosure.count()) await disclosure.locator('summary').click();
  await page.locator('#statement-provider').selectOption('paypay_card');
  await page.locator('#statement-file').setInputFiles({ name: 'synthetic-review.csv', mimeType: 'text/csv', buffer: Buffer.from(csv(extra)) });
  await click('取り込んで照合');
  await page.getByText(/件を取り込み、照合しました。/).waitFor();
}
async function decideManual() {
  const item = pending('Synthetic Manual'); await item.locator('summary').click();
  await press(item.getByRole('button', { name: '同じ支出', exact: true }));
  await page.getByRole('button', { name: '一致 2件', exact: true }).waitFor();
}
try {
  await page.goto(process.env.PWA_E2E_URL); await readyHome();
  await createAccount('Synthetic Card', 'credit_card', 'paypay_card');
  await addExpense('Synthetic Automatic', 1200, '食費', 'Synthetic Card');
  await addExpense('Synthetic Manual', 550, '食費', 'Synthetic Card');
  await page.locator('#reconciliation-tab').click();
  assert.equal(await page.locator('.reconciliation-attention').count(), 0);
  await importCsv();
  await page.getByRole('button', { name: '一致 1件', exact: true }).waitFor();
  const notice = page.locator('.reconciliation-attention');
  assert.equal(await notice.getAttribute('open'), '');
  await notice.getByText('対象明細を選ぶ', { exact: true }).click();
  await notice.getByRole('button', { name: /Synthetic Unknown.*を確認する$/ }).click();
  assert.equal(await pending('Synthetic Unknown').getAttribute('open'), '');
  await click('注意文を確認した'); await page.waitForFunction(() => !document.querySelector('.reconciliation-attention')?.open); assert.equal(await notice.getAttribute('open'), null);
  await decideManual();
  await page.getByRole('button', { name: '一致 2件', exact: true }).click();
  await matched('Synthetic Manual').locator('summary').click();
  await matched('Synthetic Manual').getByText('判定：手動で一致', { exact: true }).waitFor();
  await matched('Synthetic Manual').getByText(/家計簿：2026-09-30 · Synthetic Manual · ¥550/).waitFor();
  await matched('Synthetic Automatic').locator('summary').click();
  await matched('Synthetic Automatic').getByText('判定：自動で一致', { exact: true }).waitFor();
  assert.equal(await matched('Synthetic Automatic').getByRole('button', { name: '一致を取り消す', exact: true }).count(), 0);
  if (process.env.PWA_REVIEW_MATCHED_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_REVIEW_MATCHED_SCREENSHOT_PATH, fullPage: true, animations: 'disabled' });
  await press(matched('Synthetic Manual').getByRole('button', { name: '一致を取り消す', exact: true }));
  await page.getByRole('button', { name: '一致 1件', exact: true }).waitFor();
  await click('照合を更新する'); await page.getByRole('button', { name: '要確認 1件', exact: true }).waitFor();
  await pending('Synthetic Manual').locator('summary').click();
  assert.equal(await pending('Synthetic Manual').locator('.slip-record .slip-differs').textContent(), '¥550');
  await press(pending('Synthetic Manual').getByRole('button', { name: '同じ支出', exact: true }));
  await page.getByRole('button', { name: '一致 2件', exact: true }).waitFor();
  await pending('Synthetic Unknown').locator('summary').click();
  await press(pending('Synthetic Unknown').getByRole('button', { name: '不正利用？', exact: true }));
  await page.getByRole('button', { name: '不正利用？ 1件', exact: true }).waitFor();
  await page.getByRole('button', { name: '不正利用？ 1件', exact: true }).click(); await suspected().locator('summary').click();
  await suspected().getByText('カード：PayPayカード', { exact: true }).waitFor();
  await suspected().getByText(/マークした日時：/).waitFor();
  assert.equal(await suspected().getByRole('link', { name: 'カード会社の公式案内' }).getAttribute('href'), 'https://www.paypay-card.co.jp/service/004962.html');
  assert.equal(await notice.getAttribute('open'), null, 'acknowledged targets stay collapsed');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.PWA_REVIEW_SUSPECTED_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_REVIEW_SUSPECTED_SCREENSHOT_PATH, fullPage: true, animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'dark' });
  if (process.env.PWA_REVIEW_DARK_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_REVIEW_DARK_SCREENSHOT_PATH, fullPage: true, animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'light' });
  await context.setOffline(true);
  await press(suspected().getByRole('button', { name: '自分の利用だった', exact: true }));
  await page.getByRole('button', { name: '不正利用？ 0件', exact: true }).waitFor();
  await pending('Synthetic Unknown').locator('summary').click();
  await press(pending('Synthetic Unknown').getByRole('button', { name: '不正利用？', exact: true }));
  await page.getByRole('button', { name: '不正利用？ 1件', exact: true }).waitFor();
  await context.setOffline(false);
  await page.reload();
  await readyHome();
  await page.locator('#reconciliation-tab').click();
  await page.getByRole('button', { name: '一致 2件', exact: true }).waitFor();
  await page.getByRole('button', { name: '不正利用？ 1件', exact: true }).waitFor();
  await page.locator('#reconciliation-suspected').waitFor();
  assert.equal(await notice.getAttribute('open'), null);
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active);
  await context.setOffline(true); await page.reload(); await readyHome();
  await page.locator('#reconciliation-tab').click();
  await page.getByRole('button', { name: '一致 2件', exact: true }).click();
  await page.getByRole('button', { name: '不正利用？ 1件', exact: true }).click();
  assert.equal(await notice.getAttribute('open'), null, 'acknowledgement survives a genuine offline restart');
  await context.setOffline(false);
  await page.locator('#settings-tab').click(); await page.locator('#settings-tab').click(); await click('バックアップと復元');
  const download = page.waitForEvent('download'); await page.locator('#backup-export').click();
  const buffer = await readFile(await (await download).path()); await waitForBackupExportReady(page);
  const navigation = page.waitForNavigation({ waitUntil: 'load' });
  await page.locator('#backup-file').setInputFiles({ name: 'synthetic-review.kmb', mimeType: 'application/vnd.kakeimatch.backup', buffer });
  await navigation; await readyHome();
  await page.locator('#reconciliation-tab').click();
  await page.getByRole('button', { name: '一致 2件', exact: true }).waitFor();
  await page.getByRole('button', { name: '不正利用？ 1件', exact: true }).click(); await suspected().locator('summary').click();
  await press(suspected().getByRole('button', { name: '自分の利用だった', exact: true }));
  await page.getByRole('button', { name: '不正利用？ 0件', exact: true }).waitFor();
  await pending('Synthetic Unknown').locator('summary').click();
  await press(pending('Synthetic Unknown').getByRole('button', { name: '不正利用？', exact: true }));
  await page.getByRole('button', { name: '不正利用？ 1件', exact: true }).click(); await suspected().locator('summary').click();
  await press(suspected().getByRole('button', { name: '不正利用？を解除する', exact: true }));
  await page.getByRole('button', { name: '不正利用？ 0件', exact: true }).waitFor();
  await page.getByRole('button', { name: '一致 2件', exact: true }).click(); await matched('Synthetic Manual').locator('summary').click();
  await press(matched('Synthetic Manual').getByRole('button', { name: '一致を取り消す', exact: true }));
  await page.getByRole('button', { name: '一致 1件', exact: true }).waitFor();
  await pending('Synthetic Manual').locator('summary').click();
  assert.equal(await pending('Synthetic Manual').locator('.slip-record .slip-differs').textContent(), '¥550', 'backup preserves the pre-match amount for undo');
  await importCsv([[4200, 'Synthetic New Attention']]);
  await page.getByRole('button', { name: '記録なし 2件', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.reconciliation-attention')?.open);
  await notice.waitFor(); assert.equal(await notice.getAttribute('open'), '', 'a new attention target reopens the notice');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: automatic/manual history, safe undo and rematch, suspected-use decisions, conditional attention acknowledgement/new targets, offline decisions/restart, reload and backup restore at 375px.');
} catch (error) { console.error(error); try { console.log(await page.locator('body').innerText()); } catch { /* The page may have crashed; preserve the original failure. */ } throw error; }
finally { await browser.close(); }
