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
const click = name => page.getByRole('button', { name, exact: true }).click();

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
    await page.getByText(`明細サービス：${({ paypay_card: 'PayPayカード', smbc_card: '三井住友カード', rakuten_card: '楽天カード' })[provider]}`, { exact: true }).waitFor();
  }
}

async function addExpense(merchant, amount, category, account) {
  await page.locator('#home-tab').click(); await click('記録を追加'); await click('支出'); await click('手入力');
  await page.locator('#manual-transaction-payee').fill(merchant);
  await page.locator('#manual-transaction-date').fill('2026-09-30');
  await page.locator('#manual-transaction-amount').fill(String(amount));
  await page.locator('#manual-transaction-category').selectOption({ label: category });
  await page.locator('#manual-transaction-account').selectOption({ label: account });
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
}

async function seedMerchantLearning(merchant, categoryId) {
  await page.evaluate(({ merchant, categoryId }) => new Promise((resolve, reject) => {
    const profileId = localStorage.getItem('kakeimatch.local-profile.v1');
    const request = indexedDB.open('kakeimatch-local-data');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('records', 'readwrite'); const store = tx.objectStore('records');
      for (let index = 0; index < 3; index += 1) {
        const id = `synthetic-learning:${index}`;
        const value = { targetType: 'category-learning', receiptId: `synthetic-receipt:${index}`, normalizedMerchant: merchant,
          merchantCategoryId: categoryId, items: [], confirmedAt: `2026-09-${String(27 + index).padStart(2, '0')}T00:00:00.000Z` };
        store.put({ id, kind: 'correction-audit', value, updatedAt: value.confirmedAt, profileId, key: `${profileId}\u0000${id}` });
      }
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
  }), { merchant: merchant.toLowerCase(), categoryId });
}

const headers = '利用日/キャンセル日,利用店名・商品名,利用者,決済方法,支払区分,利用金額,手数料,支払総額,当月支払金額,翌月以降繰越金額,調整額,当月お支払日';
const rows = [
  ['2026/09/30', 1200, 'Synthetic Auto Market'],
  ['2026/09/30', 500, 'Synthetic Difference Shop'],
  ['2026/09/30', 600, 'Synthetic Other Account Shop'],
  ['2026/09/30', 700, 'Synthetic Learned Market'],
  ['2026/09/30', 800, 'Synthetic New Merchant'],
].map(([date, amount, merchant]) => `${date},${merchant},Synthetic User,PayPayクレジット,1回,${amount},0,${amount},${amount},0,0,2026/10/27`);
const csv = `${headers}\n${rows.join('\n')}\n`;

try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await createAccount('Synthetic PayPay Card', 'credit_card', 'paypay_card');
  await createAccount('Synthetic SMBC Card', 'credit_card', 'smbc_card');
  await createAccount('Synthetic Rakuten Card', 'credit_card', 'rakuten_card');
  await createAccount('Synthetic Cash Wallet', 'cash', null);
  await click('設定へ戻る');
  await click('カテゴリ'); await click('基本カテゴリを用意する'); await page.getByText('基本カテゴリを用意しました。', { exact: true }).waitFor();
  await click('設定へ戻る');

  await addExpense('Synthetic Auto Market', 1200, '食費', 'Synthetic PayPay Card');
  await addExpense('Synthetic Difference Shop', 550, '食費', 'Synthetic PayPay Card');
  await addExpense('Synthetic Other Account Shop', 600, '食費', 'Synthetic SMBC Card');
  await addExpense('Synthetic Cash Store', 300, '食費', 'Synthetic Cash Wallet');

  await page.locator('#reconciliation-tab').click();
  const importer = page.locator('summary').filter({ hasText: '明細CSVを取り込む' }); if (await importer.count()) await importer.click();
  await page.locator('#statement-provider').selectOption('paypay_card');
  assert.equal(await page.locator('#statement-account').count(), 0, 'statement import must not ask for a payment source');
  await page.locator('#statement-file').setInputFiles({ name: 'synthetic-reconciliation-paypay-card.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await click('取り込んで照合');
  await page.getByText('5件を取り込み、照合しました。重複 0件。対象外 0件、要確認 0件。', { exact: true }).waitFor();
  // A record in another card account still matches: payment sources do not scope reconciliation.
  await page.getByText(/自動確認済み 2件/).waitFor();
  await page.getByText(/要確認 1件 · 記録なし 2件/).waitFor();
  await page.getByText(/明細待ち 0件/).waitFor();

  const difference = page.locator('#local-view details').filter({ hasText: 'Synthetic Difference Shop' });
  await difference.locator('summary').click();
  await difference.getByText('家計簿：2026-09-30 · Synthetic Difference Shop · ¥550 · Synthetic PayPay Card', { exact: true }).waitFor();
  await difference.getByText('差分：金額差 ¥50（明細 ¥500 / 家計簿 ¥550）', { exact: true }).waitFor();
  assert.equal(await difference.locator('select').count(), 0, 'matching an existing record must not ask for a payment source');
  await difference.getByRole('button', { name: '別の支出', exact: true }).click();
  await page.getByText(/要確認 0件 · 記録なし 3件/).waitFor();
  const learned = page.locator('#local-view details').filter({ hasText: 'Synthetic Learned Market' }); await learned.locator('summary').click();
  const learnedCategory = learned.locator('select[id^="category-"]');
  const foodId = await learnedCategory.locator('option').evaluateAll(options => options.find(option => option.textContent === '食費')?.value ?? '');
  await seedMerchantLearning('synthetic learned market', foodId);
  await page.reload(); await page.locator('#reconciliation-tab').click();
  const refreshedLearned = page.locator('#local-view details').filter({ hasText: 'Synthetic Learned Market' }); await refreshedLearned.locator('summary').click();
  assert.equal(await refreshedLearned.locator('select[id^="category-"]').locator('option:checked').textContent(), '食費');

  const newMerchant = page.locator('#local-view details').filter({ hasText: 'Synthetic New Merchant' }); await newMerchant.locator('summary').click();
  await newMerchant.getByRole('button', { name: 'カテゴリを追加', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('カテゴリ名', { exact: true }).fill('Synthetic Reconciliation Category');
  await dialog.getByRole('button', { name: '追加する', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await newMerchant.locator('select[id^="category-"]').locator('option:checked').textContent(), 'Synthetic Reconciliation Category');
  // The payment source is asked for only when registering, preselected from the optional provider metadata.
  const registrationAccount = newMerchant.locator('select[id^="account-"]');
  assert.equal(await registrationAccount.locator('option:checked').textContent(), 'Synthetic PayPay Card');
  assert.equal(await registrationAccount.locator('option', { hasText: 'Synthetic Cash Wallet' }).count(), 0);
  await context.setOffline(true);
  await newMerchant.getByRole('button', { name: '支出として登録', exact: true }).click();
  await page.getByText(/要確認 0件 · 記録なし 2件/).waitFor();
  await context.setOffline(false);
  await page.reload(); await page.locator('#reconciliation-tab').click();
  await page.getByText(/要確認 0件 · 記録なし 2件/).waitFor();
  await page.locator('#local-view summary').filter({ hasText: 'Synthetic Difference Shop' }).waitFor();
  await page.getByText('自動確認済みの内容を見る（2件）', { exact: true }).click();
  await page.locator('#local-view summary').filter({ hasText: 'Synthetic Other Account Shop' }).click();
  await page.getByText('レシート：2026-09-30 · Synthetic Other Account Shop · ¥600', { exact: true }).waitFor();
  assert.equal(await page.locator('#local-view summary').filter({ hasText: 'Synthetic New Merchant' }).count(), 0);
  assert.equal(await page.locator('#local-view').getByText('Synthetic Cash Store', { exact: false }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.PWA_RECONCILIATION_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RECONCILIATION_SCREENSHOT_PATH, fullPage: true });

  // Leaving for home while the reconciliation redraw is still running keeps home on screen.
  const refresh = await page.evaluateHandle(() => {
    const button = [...document.querySelectorAll('#local-view button')].find(node => node.textContent === '照合を更新する');
    button.click(); document.querySelector('#home-tab').click();
    return button;
  });
  await page.waitForFunction(button => !button.disabled, refresh);
  await page.waitForFunction(() => document.querySelector('#home-summary')?.getAttribute('aria-busy') === 'false', undefined, { timeout: 10000 });
  assert.equal(await page.locator('#household-view').isVisible(), true, 'home must stay shown after the old redraw finishes');
  assert.equal(await page.locator('#reconciliation-tab').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(errors, []);
  console.log('PASS: provider-only import, cross-account automatic Actual expense matching, amount comparison and pair rejection, category learning and inline creation, and offline resolution persistence, and leaving mid-redraw keeps home at 375px.');
} catch (error) {
  console.log(await page.locator('body').innerText()); throw error;
} finally { await browser.close(); }
