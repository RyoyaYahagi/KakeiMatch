import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { waitForBackupExportReady } from '../test/backup-e2e-helpers.mjs';

const url = process.env.PWA_E2E_URL;
if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Use a local synthetic PWA (Vite dev server) only.');
const root = new URL('../../../', import.meta.url);
const seed = await readFile(new URL('test/fixtures/ios-migration/synthetic.kmb', root));
const scenarios = JSON.parse(await readFile(new URL('test/fixtures/ios-parity/scenarios.json', root), 'utf8'));
const outputRoot = process.env.PARITY_OUTPUT ? new URL(`file://${process.env.PARITY_OUTPUT.replace(/\/$/, '')}/`) : new URL('test/fixtures/ios-parity/', root);
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64');
const headers = '利用日/キャンセル日,利用店名・商品名,利用者,決済方法,支払区分,利用金額,手数料,支払総額,当月支払金額,翌月以降繰越金額,調整額,当月お支払日';
const csv = `${headers}\n2026/10/15,Parity CSV,本人,PayPayクレジット,1回,4321,0,4321,4321,0,0,2026/11/27\n`;
try {
  for (const scenario of scenarios.filter(s => !process.env.PARITY_SCENARIO || s.id === process.env.PARITY_SCENARIO)) {
    console.log(`START ${scenario.id}`);
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 844 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
    await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-10-15T03:00:00Z'));
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const click = name => page.getByRole('button', { name, exact: true }).click();
    const dir = new URL(`${scenario.id}/`, outputRoot);
    await mkdir(dir, { recursive: true });
    async function settings(name) { await page.locator('#settings-tab').click(); await click(name); }
    async function readSnapshot() { return page.evaluate(async id => (await import('/scripts/parity-snapshot.mjs')).snapshot(id), scenario.id); }
    async function checkpoint(name = 'ledger-snapshot') {
      const snapshot = await readSnapshot();
      if (scenario.id === 'reconciliation-confirm-cancel') {
        // Guard the normalization against treating only the latest incremental run
        // as the screen's full state (matched history spans earlier runs).
        for (const [label, state] of [['一致', 'matched'], ['要確認', 'needs-review'], ['記録なし', 'unmatched']]) {
          await page.getByRole('button', { name: `${label} ${snapshot.reconciliation.counts[state]}件`, exact: true }).waitFor();
        }
      }
      await writeFile(new URL(`${name}.json`, dir), `${JSON.stringify(snapshot, null, 2)}\n`);
      await settings('バックアップと復元');
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#backup-export').click();
      const download = await downloadPromise;
      await download.saveAs(fileURLToPath(new URL(name === 'ledger-snapshot' ? 'household.kmb' : `${name}.kmb`, dir)));
      await waitForBackupExportReady(page);
      return snapshot;
    }
    async function manual(kind, payee, amount, category, account) {
      await page.locator('#home-tab').click(); await click('記録を追加'); await click(kind === 'expense' ? '支出を手入力' : '収入');
      await page.locator('#manual-transaction-payee').fill(payee);
      await page.locator('#manual-transaction-date').fill('2026-10-15');
      await page.locator('#manual-transaction-amount').fill(String(amount));
      await page.locator('#manual-transaction-category').selectOption({ label: category });
      await page.locator('#manual-transaction-account').selectOption({ label: account });
      await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
    }
    async function detail(payee) { await page.locator('#receipt-tab').click(); await page.getByRole('button', { name: new RegExp(`^${payee} ·`) }).click(); }
    async function remove() { page.once('dialog', dialog => dialog.accept()); await click('削除する'); await page.getByText('削除しました。', { exact: true }).waitFor(); }
    async function importCSV() {
      await page.locator('#reconciliation-tab').click();
      const disclosure = page.locator('summary').filter({ hasText: '明細CSVを取り込む' }); await disclosure.waitFor();
      if (!await page.locator('#statement-provider').isVisible()) await disclosure.click();
      await page.locator('#statement-provider').selectOption('paypay_card');
      await page.locator('#statement-file').setInputFiles({ name: 'parity.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await click('取り込んで照合');
      await page.getByText(/件を取り込み、照合しました。/).waitFor();
    }
    try {
      await page.goto(url); await page.getByText('今月の支出 ¥0', { exact: false }).waitFor();
      await settings('バックアップと復元');
      const navigation = page.waitForNavigation({ waitUntil: 'load' });
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#backup-file').setInputFiles({ name: 'synthetic.kmb', mimeType: 'application/vnd.kakeimatch.backup', buffer: seed });
      await navigation;
      await page.waitForFunction(() => document.querySelector('#home-summary')?.getAttribute('aria-busy') === 'false');
      if (scenario.id === 'baseline') {
        const snapshot = await readSnapshot();
        // Independent DOM evidence: the same totals used by home and records.
        await page.getByText(`今月の支出 ¥${snapshot.monthly[0].expenseYen.toLocaleString('ja-JP')}`, { exact: false }).waitFor();
        await page.locator('#receipt-tab').click();
        await page.getByRole('button', { name: /^スーパーみどり ·/ }).first().waitFor();
        await writeFile(new URL('dom-evidence.json', dir), JSON.stringify({ homeExpenseYen: snapshot.monthly[0].expenseYen, receipt: 'スーパーみどり', checked: true }, null, 2) + '\n');
      } else if (scenario.id === 'manual-expense-income-retry') {
        await manual('expense', 'Parity Shop', 1500, '食費', '現金');
        await manual('income', 'Parity Employer', 200000, '給与', 'メイン口座');
        // A completed UI form cannot be resent with its old ID. Reload must not repost.
        await page.reload(); await page.waitForFunction(() => document.querySelector('#home-summary')?.getAttribute('aria-busy') === 'false');
        const snapshot = await readSnapshot();
        assert.equal(snapshot.transactions.filter(t => t.payee === 'Parity Shop').length, 1);
        assert.equal(snapshot.transactions.filter(t => t.payee === 'Parity Employer').length, 1);
      } else if (scenario.id === 'receipt-single-and-split') {
        for (const split of [false, true]) {
          await page.locator('#home-tab').click(); await click('記録を追加');
          await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: png });
          await page.locator('#receipt-merchant').fill(split ? 'Parity Split' : 'Parity Receipt');
          await page.locator('#receipt-date').fill('2026-10-15');
          await page.locator('#receipt-amount').fill('1400');
          await page.locator('#receipt-category').selectOption({ label: '食費' });
          await page.locator('#receipt-account').selectOption({ label: '現金' });
          if (split) {
            for (const [index, name, amount, category] of [[0, 'Parity Apple', '900', '食費'], [1, 'Parity Soap', '500', '日用品']]) {
              await click('品目一覧'); await click('品目を追加');
              const item = page.locator('[data-receipt-item]').nth(index); await item.waitFor();
              if (await item.getAttribute('open') === null) await item.locator('summary').click();
              await item.locator('[data-item-name]').fill(name); await item.locator('[data-item-amount]').fill(amount); await item.locator('[data-item-category]').selectOption({ label: category });
            }
            await click('全体');
          }
          await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
        }
      } else if (scenario.id === 'transfer-edit-delete') {
        await page.locator('#home-tab').click(); await click('記録を追加'); await click('口座間の振替');
        async function fillTransfer(amount) {
          await page.getByLabel('金額（円）', { exact: true }).fill(String(amount)); await page.getByLabel('日付', { exact: true }).fill('2026-10-15');
          await page.getByLabel('振替元口座', { exact: true }).selectOption({ label: 'メイン口座' }); await page.getByLabel('振替先口座', { exact: true }).selectOption({ label: '現金' });
        }
        await fillTransfer(10000); await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
        await checkpoint('created');
        await page.locator('#receipt-tab').click(); await page.getByRole('button', { name: / · 振替 · / }).click(); await click('編集する');
        await fillTransfer(12000); await click('変更を保存する'); await page.getByText('変更を保存しました。', { exact: true }).waitFor();
        await checkpoint('edited');
        await page.locator('#receipt-tab').click(); await page.getByRole('button', { name: / · 振替 · / }).click(); await remove();
      } else if (scenario.id === 'transaction-delete-undo') {
        await detail('青空食堂'); await remove(); await checkpoint('deleted');
        await click('元に戻す'); await page.getByText('削除を取り消しました。', { exact: true }).waitFor();
      } else if (scenario.id === 'statement-import-duplicate') {
        await importCSV(); await checkpoint('imported');
        await importCSV(); await page.getByText(/重複 1件/).waitFor();
      } else if (scenario.id === 'account-close-reopen') {
        await settings('支払元'); await click('支払元を追加する'); await page.getByLabel('支払元の名前', { exact: true }).fill('Parity Empty'); await click('追加する');
        await click('Parity Empty · 利用中'); await click('利用終了'); await page.locator('[data-detail="状態"] dd').getByText('利用終了', { exact: true }).waitFor();
        await checkpoint('closed');
        await settings('支払元'); await page.locator('.closed-accounts summary').click(); await click('Parity Empty · 利用終了'); await click('利用を再開する');
        await page.locator('[data-detail="状態"] dd').getByText('利用中', { exact: true }).waitFor();
      } else if (scenario.id === 'category-hide-delete') {
        await settings('カテゴリ'); await page.getByRole('button', { name: /^食費 ·/ }).click(); await click('カテゴリを非表示にする');
        await page.locator('[data-detail="状態"] dd').getByText('非表示', { exact: true }).waitFor();
        await settings('カテゴリ'); await click('カテゴリを追加する'); await page.getByLabel('カテゴリ名', { exact: true }).fill('Parity Temporary'); await click('追加する');
        await page.getByRole('button', { name: /^Parity Temporary ·/ }).click(); page.once('dialog', dialog => dialog.accept()); await click('カテゴリを削除する'); await page.getByRole('button', { name: 'カテゴリを追加する', exact: true }).waitFor();
      } else if (scenario.id === 'budget-change') {
        await settings('予算設定'); await page.locator('#budget-edit-month').waitFor(); await page.getByLabel('全体予算', { exact: true }).fill('90000');
        await click('基本予算を保存'); await page.getByText('予算を保存しました。', { exact: true }).waitFor();
      } else if (scenario.id === 'reconciliation-confirm-cancel') {
        await page.locator('#reconciliation-tab').click(); await click('もう一度照合する');
        await page.getByRole('button', { name: 'もう一度照合する', exact: true }).waitFor({ state: 'visible' });
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'もう一度照合する' && !b.disabled));
        const pending = page.locator('#reconciliation-pending .review-item').filter({ hasText: '青空食堂' });
        await pending.locator('summary').click(); await pending.getByRole('button', { name: '同じ支出', exact: true }).click();
        await page.getByText(/要確認 0件/).waitFor(); await checkpoint('confirmed');
        await page.locator('#reconciliation-tab').click(); await page.getByText(/一致した内容を見る/).click();
        const matched = page.locator('#reconciliation-matched details').filter({ has: page.locator('summary').filter({ hasText: '青空食堂' }) });
        await matched.locator('summary').click(); page.once('dialog', dialog => dialog.accept());
        await matched.getByRole('button', { name: '一致を取り消す', exact: true }).click();
        await page.getByRole('button', { name: '一致 4件', exact: true }).waitFor();
        await page.clock.setFixedTime(new Date('2026-10-15T03:01:00Z'));
        await click('もう一度照合する'); await page.getByText(/要確認 1件/).waitFor();
      } else throw new Error(`No UI actions: ${scenario.id}`);
      await checkpoint();
      assert.deepEqual(errors, []);
      console.log(`PASS ${scenario.id}`);
    } catch (error) { console.error(await page.locator('body').innerText()); throw error; }
    finally { await context.close(); }
  }
} finally { await browser.close(); }
