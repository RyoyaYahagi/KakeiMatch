import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Captures the README screenshots from synthetic data only.
// Usage: PWA_E2E_URL=http://127.0.0.1:5199 node scripts/readme-screenshots.mjs
const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a local PWA or an isolated synthetic preview.');
const output = name => fileURLToPath(new URL(`../../../docs/screenshots/migration/${name}`, import.meta.url));
const fixture = JSON.parse(await readFile(new URL('../test/fixtures/ios-migration/fixture.json', import.meta.url), 'utf8'));
const ensureDir = async path => (await import('node:fs/promises')).mkdir(new URL(path, import.meta.url), { recursive: true });
for (const dir of ['home','records','reconciliation','receipt']) await ensureDir(`../../../docs/screenshots/migration/${dir}/`);
const now = new Date(fixture.now);
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox', '--lang=ja-JP'], env: { ...process.env, LANG: 'ja_JP.UTF-8', LANGUAGE: 'ja' } });

async function open(viewport, { signedIn = false } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 3, colorScheme: 'light', locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
  if (!signedIn) await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
  const page = await context.newPage();
  await page.clock.setFixedTime(now);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, errors };
}
const clicker = page => name => page.getByRole('button', { name, exact: true }).click();
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))));
}

const accounts = fixture.accounts.map(({name,type,provider}) => [name,type,provider]);
const expenses = fixture.transactions.filter(row => row.type === 'expense').map(row => [row.date,row.payee,row.amountYen,row.category,row.account]);
const statement = fixture.statement.map(({date,merchant,amountYen}) => [date,merchant,amountYen]);
const receiptItems = fixture.receipt.items;
const paypayHeaders = '利用日/キャンセル日,利用店名・商品名,利用者,決済方法,支払区分,利用金額,手数料,支払総額,当月支払金額,翌月以降繰越金額,調整額,当月お支払日';
const csv = `${paypayHeaders}\n${statement.map(([date, merchant, amount]) => `${date},${merchant},本人,PayPayクレジット,1回,${amount},0,${amount},${amount},0,0,2026/11/27`).join('\n')}\n`;

async function createAccount(page, [name, type, provider]) {
  const click = clicker(page);
  await page.locator('#settings-tab').click(); await click('支払元'); await click('支払元を追加する');
  await page.locator('select[name="accountType"]').selectOption(type);
  await page.getByLabel('支払元の名前', { exact: true }).fill(name); await click('追加する');
  const account = page.getByRole('button', { name: `${name} · 利用中`, exact: true }); await account.waitFor();
  if (provider) {
    await account.click(); await click('編集する');
    await page.locator('select[name="statementProvider"]').selectOption(provider);
    await click('変更を保存');
    await page.locator('[data-detail="明細サービス"] dd').waitFor();
  }
  await page.locator('#settings-tab').click(); await page.locator('#settings-tab').click();
}

async function household() {
  const { context, page, errors } = await open({ width: 390, height: 844 });
  const click = clicker(page);
  await page.goto(url); await page.getByText('今月の支出 ¥0').waitFor();
  for (const account of accounts) await createAccount(page, account);
  await click('カテゴリ'); await click('収入カテゴリ');
  await click('カテゴリを追加する'); await page.getByLabel('カテゴリ名', { exact: true }).fill(fixture.incomeCategory); await click('追加する');
  await page.getByRole('button', { name: /^給与 ·/ }).waitFor();

  async function manual(kind, [date, payee, amount, category, account]) {
    await page.locator('#home-tab').click(); await click('記録を追加'); await click(kind);
    await page.locator('#manual-transaction-payee').fill(payee);
    await page.locator('#manual-transaction-date').fill(date);
    await page.locator('#manual-transaction-amount').fill(String(amount));
    await page.locator('#manual-transaction-category').selectOption({ label: category });
    await page.locator('#manual-transaction-account').selectOption({ label: account });
    await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
  }
  for (const income of fixture.transactions.filter(row => row.type === 'income')) await manual('収入', [income.date, income.payee, income.amountYen, income.category, income.account]);
  for (const expense of expenses) await manual('支出を手入力', expense);

  await page.locator('#settings-tab').click(); await click('予算設定'); await page.locator('#budget-edit-month').waitFor();
  await page.getByLabel('全体予算', { exact: true }).fill(String(fixture.budgetYen));
  await click('基本予算を保存'); await page.getByText('予算を保存しました。', { exact: true }).waitFor();

  await page.locator('#reconciliation-tab').click();
  const importer = page.locator('summary').filter({ hasText: '明細CSVを取り込む' }); if (await importer.count()) await importer.click();
  await page.locator('#statement-provider').selectOption('paypay_card');
  await page.locator('#statement-file').setInputFiles({ name: 'synthetic-paypay-card.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await click('取り込んで照合');
  await page.getByText(/7件を取り込み、照合しました。/).waitFor();
  await page.getByText(/要確認 1件 · 記録なし 2件/).waitFor();
  // Reload so the transient import message does not stay in the screenshot.
  await page.reload(); await page.locator('#reconciliation-tab').click();
  await page.getByText(/要確認 1件 · 記録なし 2件/).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#reconciliation-pending .review-item').length === 3);
  await settle(page); await page.screenshot({ path: output('reconciliation/needs-review-light.png') });

  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥24,730').waitFor();
  await page.evaluate(() => scrollTo(0, 0));
  await settle(page); await page.screenshot({ path: output('home/populated-light.png') });

  await page.locator('#receipt-tab').click();
  await settle(page); await page.screenshot({ path: output('records/populated-light.png') });
  if (errors.length) throw new Error(errors.join('\n'));
  await context.close();
}

async function receiptImage() {
  const { context, page } = await open({ width: 390, height: 844 });
  const rows = receiptItems.map(({ name, amountYen }) => `<tr><td>${name}</td><td>¥${amountYen.toLocaleString('ja-JP')}</td></tr>`).join('');
  await page.setContent(`<body style="margin:0;background:#d9d4cc;display:grid;place-items:center;height:100vh;font:15px sans-serif">
    <div style="background:#fffdf8;width:230px;padding:22px 20px;box-shadow:0 2px 8px #0003;transform:rotate(-2deg)">
      <div style="text-align:center;font-weight:700;font-size:18px">スーパーみどり</div>
      <div style="text-align:center;font-size:12px;margin:4px 0 12px">2026年10月14日 12:31</div>
      <table style="width:100%;font-size:13px;border-collapse:collapse">${rows}</table>
      <div style="border-top:1px dashed #555;margin-top:10px;padding-top:8px;display:flex;justify-content:space-between;font-weight:700"><span>合計</span><span>¥2,138</span></div>
    </div></body>`);
  const buffer = await page.screenshot({ type: 'png' });
  await context.close();
  return buffer;
}

async function receipt() {
  const image = await receiptImage();
  const { context, page, errors } = await open({ width: 390, height: 844 }, { signedIn: true });
  let used = 0;
  await context.route('**/api/auth/get-session', route => route.fulfill({ json: { user: { id: 'synthetic-user', name: 'Synthetic User' }, session: { id: 'synthetic-session', expiresAt: '2099-01-01T00:00:00Z' } } }));
  await context.route('**/api/auth/passkey/list-user-passkeys', route => route.fulfill({ json: [] }));
  await context.route('**/api/ai/usage', route => route.fulfill({ json: { plan: 'free', month: '2026-10', used, limit: 30, remaining: 30 - used } }));
  await context.route('**/api/ai/token', route => route.fulfill({ json: { token: 'synthetic-token', expiresAt: Math.floor(Date.now() / 1000) + 600 } }));
  await context.route('**/api/ai/gemini', route => {
    used += 1;
    return route.fulfill({ json: { documentKind: 'receipt', merchant: 'スーパーみどり', purchasedDate: '2026-10-14', purchasedTime: '12:31', totalAmountYen: 2138, taxAmountYen: 158, items: receiptItems, warnings: [] } });
  });
  await context.route('**/api/ai/jev', route => {
    const body = route.request().postDataJSON();
    const answer = name => {
      const choice = body.categories.find(category => category.name === name);
      return { type: 'choice', choice: choice.id, confidence: 1, probabilities: Object.fromEntries(body.categories.map(category => [category.id, category.id === choice.id ? 1 : 0])) };
    };
    const answers = Object.fromEntries(body.itemIndexes.map(index => [`item_${index}`, answer(receiptItems[index].name.includes('洗剤') ? '日用品' : '食費')]));
    return route.fulfill({ json: { model: 'synthetic-model', answers } });
  });
  const click = clicker(page);
  await page.goto(url); await page.getByText('今月の支出 ¥0').waitFor();
  await createAccount(page, accounts[0]);
  await page.locator('#home-tab').click(); await click('記録を追加');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic-receipt.png', mimeType: 'image/png', buffer: image });
  await click('AIで読み取る');
  await page.waitForFunction(() => document.querySelector('#receipt-merchant')?.value === 'スーパーみどり', null, { timeout: 15000 });
  await page.getByText('日用品 ¥546', { exact: true }).waitFor();
  await page.locator('#receipt-account').selectOption({ label: accounts[0][0] });
  // Keep the lower part of the receipt image above the fields that AI filled in.
  const intro = await page.getByText('画像から店名・日付・金額・品目を読み取り', { exact: false }).boundingBox();
  await page.evaluate(y => scrollBy(0, y), intro.y - 190);
  await settle(page); await page.screenshot({ path: output('receipt/ai-result-light.png') });
  if (errors.length) throw new Error(errors.join('\n'));
  await context.close();
}

try {
  await household();
  await receipt();
  console.log('Migration reference screenshots updated from ios-migration/fixture.json.');
} finally {
  await browser.close();
}
