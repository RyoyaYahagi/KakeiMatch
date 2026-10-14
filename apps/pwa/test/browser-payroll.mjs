import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to a synthetic local preview.');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const page = await context.newPage(); page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', error => errors.push(error.message));
let fail = false; let payload;
const extraction = { documentKind: 'pay_slip', employerName: 'Synthetic Employer', paymentDate: null, payPeriod: '2026年10月分', payType: 'salary',
  grossPayYen: 340000, netPayYen: 260000, deductions: { incomeTaxYen: 9000, residentTaxYen: null, healthInsuranceYen: 20000, pensionYen: 40000, employmentInsuranceYen: 3000, otherYen: 8000, totalYen: 80000 },
  allowances: [{ name: '通勤手当', amountYen: 10000 }], warnings: [{ field: 'paymentDate', code: 'unreadable' }] };
await context.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/ai/token') return route.fulfill({ json: { token: 'synthetic-token', expiresAt: Math.floor(Date.now() / 1000) + 600 } });
  if (path === '/api/ai/payroll') { payload = route.request().postDataJSON(); return route.fulfill({ status: fail ? 502 : 200, json: fail ? { error: 'invalid_ai_response' } : { extraction, model: 'synthetic-model', promptVersion: 'payroll-v1' } }); }
  return route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } });
});
const click = name => page.getByRole('button', { name, exact: true }).click();
async function open() {
  await page.getByRole('button', { name: '記録を追加', exact: true }).click(); await page.locator('#record-sheet').getByRole('button', { name: '収入', exact: true }).click();
  await click('給与明細から入力'); await page.locator('#payroll-form').waitFor();
}
async function fillRequired() {
  await page.locator('#payroll-paymentDate').fill('2026-10-25');
  await page.locator('#payroll-category').selectOption({ label: '給与' });
  await page.locator('#payroll-account').selectOption({ label: 'Synthetic Bank' });
  await page.locator('#payroll-reviewed').check();
}
async function photo(buffer) { await page.locator('#payroll-library').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer }); await page.locator('.payroll-mask').waitFor(); }
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor(); await open();
  await page.getByRole('button', { name: 'カテゴリを追加', exact: true }).click();
  await page.getByLabel('カテゴリ名', { exact: true }).fill('給与'); await page.getByRole('dialog').getByRole('button', { name: '追加する', exact: true }).click();
  await page.getByRole('button', { name: '支払元・口座を追加', exact: true }).click();
  await page.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Bank');
  await page.getByRole('dialog').getByLabel('種類', { exact: true }).selectOption('bank');
  await page.getByRole('dialog').getByRole('button', { name: '追加する', exact: true }).click();
  const dataUrl = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 600; c.height = 500; const ctx = c.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 600, 500); ctx.fillStyle = 'black'; ctx.font = '20px sans-serif'; ctx.fillText('Synthetic employee ID 1234567', 20, 35); ctx.fillText('Synthetic Employer / salary', 20, 200); return c.toDataURL('image/png'); });
  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  await photo(png);
  const canvas = page.locator('.payroll-mask'); const rect = await canvas.boundingBox();
  await canvas.click({ position: { x: rect.width * 0.01, y: rect.height * 0.01 } });
  await canvas.click({ position: { x: rect.width * 0.9, y: rect.height * 0.2 } });
  await page.locator('#payroll-masking-confirmed').check(); await click('AIで読み取る');
  await page.getByText('△ 読み取りに不確かな項目があります。各項目を確認してください。', { exact: true }).waitFor();
  assert.equal(await page.locator('.payroll-mask').count(), 0);
  assert.equal(await page.locator('#payroll-library').inputValue(), '');
  assert.equal(await page.locator('#payroll-paymentDate').inputValue(), '');
  assert.equal(await page.locator('#payroll-netPayYen').inputValue(), '260000');
  assert.equal(payload.maskingConfirmed, true);
  const pixel = await page.evaluate(async base64 => { const image = new Image(); image.src = `data:image/jpeg;base64,${base64}`; await image.decode(); const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0); return [...ctx.getImageData(100, 50, 1, 1).data]; }, payload.imageBase64);
  assert.ok(pixel[0] < 10 && pixel[1] < 10 && pixel[2] < 10, 'masked pixels must reach the provider');
  await fillRequired();
  await page.screenshot({ path: '../../docs/screenshots/ui-payroll-confirm-375.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor();
  await page.locator('#receipt-tab').click(); await page.getByRole('button', { name: /^Synthetic Employer ·/ }).click();
  await page.getByLabel('給与明細の内訳（登録時）', { exact: true }).click();
  await page.getByText('控除合計：¥80,000', { exact: true }).waitFor();
  await page.locator('#home-tab').click(); await page.locator('#monthly-income').getByText('¥260,000', { exact: true }).waitFor();
  await open(); await photo(png); await page.locator('#payroll-masking-confirmed').check(); await click('AIで読み取る');
  await page.locator('#payroll-form').waitFor({ state: 'visible' }); await fillRequired(); await click('登録する');
  await page.getByText(/^△ この給与はすでに登録されている可能性/).waitFor();
  await click('それでも登録'); await page.getByText('登録しました。', { exact: true }).waitFor();
  fail = true; await open(); await photo(png); await page.locator('#payroll-masking-confirmed').check(); await click('AIで読み取る');
  await page.getByText(/^給与明細を読み取れませんでした/).waitFor();
  assert.equal(await page.locator('.payroll-mask').count(), 0); assert.equal(await page.locator('#payroll-library').inputValue(), '');
  await photo(png); await click('キャンセル');
  assert.equal(await page.locator('.payroll-mask').count(), 0);
  await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click();
  await open(); assert.equal(await page.locator('#payroll-capture').getAttribute('capture'), 'environment');
  await photo(png); await page.locator('#settings-tab').click();
  assert.equal(await page.locator('.payroll-mask').count(), 0);
  const stored = await page.evaluate(async () => { const db = await new Promise((resolve, reject) => { const r = indexedDB.open('kakeimatch-local-data'); r.onsuccess = () => resolve(r.result); r.onerror = reject; }); const read = store => new Promise(resolve => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); }); const records = await read('records'); const blobs = await read('blobs'); db.close(); return { payroll: records.filter(row => row.kind === 'payroll-record'), blobs }; });
  assert.equal(stored.payroll.length, 2); assert.equal(stored.payroll[0].value.confirmed.netPayYen, 260000); assert.equal(stored.blobs.length, 0);
  assert.equal(JSON.stringify(stored).includes('1234567'), false); assert.deepEqual(errors, []);
  console.log('PASS payroll: masked upload, missing date, net-only income, details, duplicates, image disposal, 375px');
} catch (error) { console.error((await page.locator('body').innerText()).slice(-4000)); throw error; } finally { await browser.close(); }
