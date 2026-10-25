import { fileURLToPath } from 'node:url';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { waitForBackupExportReady } from '../test/backup-e2e-helpers.mjs';
import { chromium } from 'playwright-core';

// Synthetic migration references; never point this at a real household.
// Usage: PWA_E2E_URL=http://127.0.0.1:5173 pnpm screenshots:migration
const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a local PWA or an isolated synthetic preview.');
const output = name => fileURLToPath(new URL(`../../../docs/screenshots/migration/${name}`, import.meta.url));
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Use a local synthetic PWA only.');
const fixture = JSON.parse(await readFile(new URL('../../../test/fixtures/ios-migration/fixture.json', import.meta.url), 'utf8'));
const now = new Date(fixture.now);
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox', '--lang=ja-JP', '--disable-gpu', '--disable-skia-runtime-opts', '--disable-font-subpixel-positioning', '--disable-lcd-text', '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout', '--disable-threaded-animation', '--disable-threaded-scrolling', '--num-raster-threads=1'], env: { ...process.env, LANG: 'ja_JP.UTF-8', LANGUAGE: 'ja' } });

async function open(viewport, { signedIn = false } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 3, reducedMotion: 'reduce', acceptDownloads: true, colorScheme: 'light', locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  await context.addInitScript(() => {
    navigator.serviceWorker.register = async () => ({});
    // Actual creates category IDs inside a Worker. Seed both realms so custom
    // category tones (ID hashes) and equal-date tie breaks cannot vary by run.
    function seedRandom() {
      let state = 240;
      const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
      Math.random = next;
      crypto.getRandomValues = array => {
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(next() * 256);
        return array;
      };
      crypto.randomUUID = () => {
        const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      };
    }
    seedRandom();
    const createObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => createObjectURL(/javascript/.test(blob.type)
      ? new Blob([`(${seedRandom.toString()})();`, blob], { type: blob.type }) : blob);
  });
  if (!signedIn) await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
  const page = await context.newPage();
  await page.clock.setFixedTime(now);
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  return { context, page, errors };
}
const clicker = page => name => page.getByRole('button', { name, exact: true }).click();
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))));
}
async function capture(page, name) {
  await mkdir(output(name.split('/')[0]), { recursive: true });
  await page.waitForFunction(() => {
    const home = document.querySelector('#home-summary');
    return !home?.checkVisibility() || home.getAttribute('aria-busy') === 'false';
  });
  await page.mouse.move(0, 0);
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => {
      localStorage.setItem('kakeimatch-theme', value);
      window.dispatchEvent(new Event('kakeimatch-theme-change'));
    }, theme);
    await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
    await settle(page);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Theme changes invalidate rotated stamp layers. Let Chromium finish its
    // raster work, then require two identical frames rather than trusting a DOM wait.
    await page.waitForTimeout(250);
    let previous;
    let stable = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const frame = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      if (previous?.equals(frame)) { stable = true; break; }
      previous = frame;
    }
    if (!stable) throw new Error(`Unstable screenshot: ${name}-${theme}`);
    await writeFile(output(`${name}-${theme}.png`), previous);
  }
  console.log(`Captured ${name} (light/dark)`);
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
  await capture(page, 'home/empty');
  await page.locator('#reconciliation-tab').click();
  await page.locator('#statement-provider').waitFor({ state: 'attached' });
  await capture(page, 'reconciliation/empty');
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

  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥24,730').waitFor();
  await capture(page, 'home/populated');
  await page.locator('#settings-tab').click(); await click('予算設定');
  await page.getByLabel('全体予算', { exact: true }).fill(String(fixture.warningBudgetYen));
  await click('基本予算を保存'); await page.getByText('予算を保存しました。', { exact: true }).waitFor();
  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥24,730').waitFor();
  await capture(page, 'home/budget-warning');
  await page.locator('#settings-tab').click(); await click('予算設定');
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
  await capture(page, 'reconciliation/needs-review');
  await page.locator('summary').filter({ hasText: '一致した内容を見る' }).click();
  await capture(page, 'reconciliation/matched');

  await page.locator('#home-tab').click(); await page.getByText('今月の支出 ¥24,730').waitFor();
  await capture(page, 'home/attention');

  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: /^スーパーみどり ·/ }).first().waitFor();
  await capture(page, 'records/populated');
  await page.getByRole('button', { name: /記録を検索|検索・絞り込み/ }).click();
  await page.locator('#transaction-search-count').waitFor();
  await page.locator('#transaction-search-keyword').fill(fixture.searchKeyword);
  await click('検索する');
  await page.locator('#transaction-search-count').getByText('2件', { exact: true }).waitFor();
  await capture(page, 'records/search');

  async function entry(kind) {
    await page.locator('#home-tab').click(); await click('記録を追加'); await click(kind);
  }
  await entry('支出を手入力'); await page.locator('#manual-transaction-amount').waitFor();
  await capture(page, 'entry/expense');
  await click('すべてのカテゴリから選ぶ'); await page.locator('.category-sheet[open]').waitFor();
  await capture(page, 'entry/category-sheet'); await page.keyboard.press('Escape');
  await page.getByLabel('くり返し', { exact: true }).selectOption({ label: '毎月' });
  await page.getByText('定期登録も作ります', { exact: true }).waitFor();
  await capture(page, 'entry/recurrence');
  await entry('収入'); await page.locator('#manual-transaction-amount').waitFor();
  await capture(page, 'entry/income');
  const chooser = page.waitForEvent('filechooser'); await click('AIで簡単入力');
  await (await chooser).setFiles({ name: 'synthetic-payroll.png', mimeType: 'image/png', buffer: await receiptImage('payroll') });
  await page.locator('.payroll-mask').waitFor(); await capture(page, 'payroll/initial');
  await entry('口座間の振替'); await page.getByLabel('振替元口座', { exact: true }).waitFor();
  await capture(page, 'entry/transfer');
  for (const [name, button] of [['recurring', '定期登録'], ['budget', '予算設定'], ['masters', 'カテゴリ'], ['contact', 'お問い合わせ'], ['backup', 'バックアップと復元']]) {
    await page.locator('#settings-tab').click(); await click(button);
    await capture(page, `${name}/initial`);
  }
  await click('マネーフォワードから移行'); await page.locator('#moneyforward-file').waitFor({ state: 'attached' });
  await capture(page, 'moneyforward/initial');
  await page.locator('#settings-tab').click(); await capture(page, 'settings/initial');
  await click('ほかの端末と同期'); await page.getByRole('dialog', { name: 'ほかの端末と同期' }).waitFor();
  await capture(page, 'device-link/initial');
  await page.getByRole('dialog', { name: 'ほかの端末と同期' }).getByRole('button', { name: '閉じる', exact: true }).click();
  // Include a real stored synthetic receipt original in the same household as the CSV.
  await page.locator('#home-tab').click(); await click('記録を追加');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic-receipt.png', mimeType: 'image/png', buffer: await receiptImage() });
  await page.locator('#receipt-merchant').fill(fixture.receipt.merchant);
  await page.locator('#receipt-date').fill(fixture.receipt.date);
  await page.locator('#receipt-amount').fill(String(fixture.receipt.totalYen));
  await page.locator('#receipt-category').selectOption({ label: '食費' });
  await page.locator('#receipt-account').selectOption({ label: accounts[0][0] });
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
  await page.locator('#settings-tab').click(); await click('バックアップと復元');
  await page.locator('#backup-export:enabled').waitFor();
  const downloading = page.waitForEvent('download'); await page.locator('#backup-export').click();
  await (await downloading).saveAs(fileURLToPath(new URL('../../../test/fixtures/ios-migration/synthetic.kmb', import.meta.url)));
  await waitForBackupExportReady(page);
  if (errors.length) throw new Error(errors.join('\n'));
  await context.close();
}

async function receiptImage(kind = 'receipt') {
  const { context, page } = await open({ width: 390, height: 844 });
  const rows = receiptItems.map(({ name, amountYen }) => `<tr><td>${name}</td><td>¥${amountYen.toLocaleString('ja-JP')}</td></tr>`).join('');
  await page.setContent(`<body style="margin:0;background:#d9d4cc;display:grid;place-items:center;height:100vh;font:15px sans-serif">
    <div style="background:#fffdf8;width:230px;padding:22px 20px;box-shadow:0 2px 8px #0003;transform:rotate(-2deg)">
      <div style="text-align:center;font-weight:700;font-size:18px">${fixture.receipt.merchant}</div>
      <div style="text-align:center;font-size:12px;margin:4px 0 12px">${fixture.receipt.date.replace(/^(\d+)-(\d+)-(\d+)$/, '$1年$2月$3日')} ${fixture.receipt.time}</div>
      <table style="width:100%;font-size:13px;border-collapse:collapse">${rows}</table>
      <div style="border-top:1px dashed #555;margin-top:10px;padding-top:8px;display:flex;justify-content:space-between;font-weight:700"><span>合計</span><span>¥${fixture.receipt.totalYen.toLocaleString('ja-JP')}</span></div>
    </div></body>`);
  if (kind === 'payroll') await page.setContent(`<body style="margin:0;background:white;padding:32px;font:20px sans-serif"><h1>合成給与明細</h1><p>${fixture.payroll.employerName}</p><p>${fixture.payroll.period}</p><p>総支給 ¥${fixture.payroll.grossPayYen}</p><p>控除合計 ¥${fixture.payroll.deductionsYen}</p><p>手取り ¥${fixture.payroll.netPayYen}</p><p>氏名・住所・社員番号なし（テスト専用）</p></body>`);
  await page.evaluate(() => document.fonts.ready);
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
  let releaseReading;
  const readingGate = new Promise(resolve => { releaseReading = resolve; });
  await context.route('**/api/ai/gemini', async route => {
    await readingGate;
    used += 1;
    return route.fulfill({ json: { documentKind: 'receipt', merchant: fixture.receipt.merchant, purchasedDate: fixture.receipt.date, purchasedTime: fixture.receipt.time, totalAmountYen: fixture.receipt.totalYen, taxAmountYen: fixture.receipt.taxYen, items: receiptItems, warnings: [] } });
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
  await page.locator('#receipt-merchant').waitFor();
  await capture(page, 'receipt/initial');
  await click('AIで読み取る');
  await page.getByText('文字を読み取っています', { exact: true }).first().waitFor();
  await capture(page, 'receipt/ai-loading');
  releaseReading();
  await page.waitForFunction(merchant => document.querySelector('#receipt-merchant')?.value === merchant, fixture.receipt.merchant, { timeout: 15000 });
  await page.getByText('日用品 ¥546', { exact: true }).waitFor();
  await page.locator('#receipt-account').selectOption({ label: accounts[0][0] });
  await capture(page, 'receipt/ai-result');
  await click('品目一覧'); await page.locator('[data-receipt-item]').first().waitFor();
  await capture(page, 'receipt/items-tab');
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
