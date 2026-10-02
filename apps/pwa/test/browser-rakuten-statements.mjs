import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to a dedicated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-01T03:00:00Z'));
const errors = [];
page.on('pageerror', error => errors.push(error.message));

const header = ['利用日', '利用店名・商品名', '利用者', '支払方法', '利用金額', '手数料/利息', '支払総額', '9月支払金額', '当月請求額', '10月繰越残高', '新規サイン'];
const normal = ['2026/09/28', 'Synthetic Market', '本人', '1回払い', '1200', '0', '1200', '1200', '1100', '0', ''];
const installment = ['2026/09/29', 'Synthetic Installment', '本人', '分割払い', '9000', '0', '9000', '3000', '3000', '0', ''];
const pairParent = ['2026/09/30', 'Synthetic Pair Parent', '本人', '1回払い', '500', '0', '500', '500', '500', '0', ''];
const continuation = ['', 'Synthetic Item Continuation', '', '', '', '', '', '', '', '', ''];
const csv = `\uFEFF${[header, normal, installment, pairParent, continuation].map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n')}\r\n`;
const bytes = Buffer.from(csv, 'utf8');
async function createMappedCardAccount(name) {
  await page.locator('#settings-tab').click();
  await page.getByRole('button', { name: '支払元', exact: true }).click();
  await page.getByRole('button', { name: '支払元を追加する', exact: true }).click();
  await page.locator('select[name="accountType"]').selectOption('credit_card');
  await page.getByLabel('支払元の名前', { exact: true }).fill(name);
  await page.getByRole('button', { name: '追加する', exact: true }).click();
  const account = page.getByRole('button', { name: `${name} · 利用中`, exact: true });
  await account.waitFor();
  await account.click();
  await page.getByRole('button', { name: '編集する', exact: true }).click();
  await page.locator('select[name="accountType"]').selectOption('credit_card');
  await page.locator('select[name="statementProvider"]').selectOption('rakuten_card');
  await page.getByRole('button', { name: '変更を保存', exact: true }).click();
  await page.getByText('明細サービス：楽天カード', { exact: true }).waitFor();
}
async function addNativeExpense(account) {
  await page.getByRole('button', { name: '設定へ戻る', exact: true }).click();
  await page.getByRole('button', { name: 'カテゴリ', exact: true }).click();
  await page.getByRole('button', { name: '基本カテゴリを用意する', exact: true }).click();
  await page.getByText('基本カテゴリを用意しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '設定へ戻る', exact: true }).click();
  await page.locator('#home-tab').click();
  await page.getByRole('button', { name: '記録を追加', exact: true }).click();
  await page.getByRole('button', { name: '支出', exact: true }).click();
  await page.getByRole('button', { name: '手入力', exact: true }).click();
  await page.locator('#manual-transaction-payee').fill('Synthetic Market');
  await page.locator('#manual-transaction-date').fill('2026-09-28');
  await page.locator('#manual-transaction-amount').fill('1200');
  await page.locator('#manual-transaction-category').selectOption({ label: '食費' });
  await page.locator('#manual-transaction-account').selectOption({ label: account });
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await page.getByText('登録しました。', { exact: true }).waitFor();
}

try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0').waitFor();
  await createMappedCardAccount('Synthetic Rakuten Card');
  await addNativeExpense('Synthetic Rakuten Card');
  const upload = async () => {
    const reconciliationTab = page.locator('#reconciliation-tab');
    if (await reconciliationTab.getAttribute('aria-pressed') !== 'true') {
      await reconciliationTab.click();
      await page.waitForFunction(() => document.querySelector('#reconciliation-tab')?.getAttribute('aria-pressed') === 'true');
    }
    await page.locator('#statement-provider').waitFor({ state: 'attached' });
    const importerSummary = page.locator('summary').filter({ hasText: '明細CSVを取り込む' });
    if (await importerSummary.count()) await importerSummary.evaluate(node => { const disclosure = node.closest('details'); if (disclosure) disclosure.open = true; });
    await page.locator('#statement-provider').waitFor({ state: 'visible' });
    await page.locator('#statement-provider').selectOption('rakuten_card');
    await page.locator('#statement-file').setInputFiles({ name: 'synthetic-rakuten.csv', mimeType: 'text/csv', buffer: bytes });
    await page.getByRole('button', { name: '取り込んで照合', exact: true }).click();
  };

  await upload();
  await page.getByText(/1件を取り込み、照合しました。重複 0件。対象外 0件、要確認 3件。/).waitFor();
  await page.getByText(/自動確認済み 1件/).waitFor();
  await page.getByText(/記録なし 0件/).waitFor();
  const importerDisclosure = page.locator('details.statement-import-disclosure');
  if (await importerDisclosure.count()) await importerDisclosure.evaluate(node => { node.open = true; });
  const reviewSummary = page.locator('summary').filter({ hasText: '楽天カード CSVの要確認 3件' });
  await reviewSummary.waitFor();
  await reviewSummary.click();
  await page.getByText('4行目: 複数行明細の可能性があるため確認してください', { exact: true }).waitFor();
  await page.getByText('5行目: 継続行または部分行の可能性があります', { exact: true }).waitFor();
  assert.equal(await page.getByText('Synthetic Pair Parent', { exact: false }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.PWA_RAKUTEN_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RAKUTEN_SCREENSHOT_PATH, fullPage: true });

  await upload();
  await page.getByText(/0件を取り込み、照合しました。重複 1件。対象外 0件、要確認 3件。/).waitFor();
  await page.getByText(/自動確認済み 1件/).waitFor();
  await page.getByText(/記録なし 0件/).waitFor();
  const automaticSummary = page.locator('summary').filter({ hasText: '自動確認済みの内容を見る（1件）' });
  if (await automaticSummary.count()) await automaticSummary.evaluate(node => { const disclosure = node.closest('details'); if (disclosure) disclosure.open = true; });
  await page.locator('#local-view summary').filter({ hasText: 'Synthetic Market' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: Rakuten UTF-8 BOM import, strict one-time purchase, review rows, continuation safety, duplicate reimport, and reconciliation at 375px.');
} catch (error) {
  console.log(await page.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
}
