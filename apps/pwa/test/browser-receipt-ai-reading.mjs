import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated test preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
// Hold each AI answer so the test can look at the screen while it waits.
const held = {};
// Later scenarios answer at once; failNext makes the next read fail like a dropped connection.
let autoRelease = false, failNext = false;
const hold = name => autoRelease ? Promise.resolve() : new Promise(resolve => { held[name] = resolve; });
let geminiSeen, jevSeen;
const geminiArrived = new Promise(resolve => { geminiSeen = resolve; });
const jevArrived = new Promise(resolve => { jevSeen = resolve; });
await context.route('**/api/ai/token', route => route.fulfill({ json: { token: 'synthetic-token', expiresAt: 9999999999 } }));
await context.route('**/api/ai/gemini', async route => {
  const released = hold('gemini'); geminiSeen(); await released;
  if (failNext) { failNext = false; await route.fulfill({ status: 503, json: { error: 'provider_unavailable' } }); return; }
  await route.fulfill({ json: { documentKind: 'receipt', merchant: 'Synthetic Reading Shop', purchasedDate: '2026-10-04', purchasedTime: null, totalAmountYen: 640, taxAmountYen: null, items: [{ name: 'Synthetic Bread', amountYen: 640 }], warnings: [] } });
});
await context.route('**/api/ai/jev', async route => {
  const released = hold('jev'); jevSeen(); await released;
  await route.fulfill({ status: 503, json: { error: 'provider_unavailable' } });
});
const click = name => page.getByRole('button', { name, exact: true }).click();
try {
  await page.goto(process.env.PWA_E2E_URL);
  await page.getByText('今月の支出 ¥0').waitFor();
  await page.locator('#settings-tab').click(); await click('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Wallet'); await click('追加する');
  await page.getByRole('button', { name: 'Synthetic Wallet · 利用中', exact: true }).waitFor();
  await page.locator('#receipt-tab').click();
  await click('記録を追加');
  // A synthetic receipt-like photo, so the reading motion over the image is visible.
  const photo = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 720;
    const context = canvas.getContext('2d'); context.fillStyle = '#f4f1ea'; context.fillRect(0, 0, 480, 720);
    context.fillStyle = '#333'; context.font = '28px sans-serif'; context.fillText('SYNTHETIC SHOP', 120, 70);
    context.font = '20px sans-serif';
    for (let line = 0; line < 14; line += 1) { context.fillText(`Synthetic item ${line + 1}`, 40, 140 + line * 36); context.fillText(`${(line + 1) * 100}`, 380, 140 + line * 36); }
    return canvas.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: photo });
  await click('AIで読み取る');
  await geminiArrived;
  // While reading: the steps as rows, the usual wait, motion and a badge on the photo, and placeholder bands. No timer or character.
  await page.locator('.reading-step.is-now').filter({ hasText: '文字を読み取っています' }).waitFor();
  assert.deepEqual(await page.locator('.reading-step').evaluateAll(rows => rows.map(row => row.className.replace('reading-step ', ''))), ['is-done', 'is-now', 'is-todo']);
  assert.equal(await page.locator('.reading-step.is-done').textContent(), '✓写真を保存しましたこの端末に。読み取れなくても消えません');
  assert.equal(await page.locator('.reading-step.is-now small').textContent(), '数秒かかります');
  assert.equal(await page.getByRole('status').filter({ hasText: '文字を読み取っています' }).count(), 1);
  assert.equal(await page.locator('.receipt-preview-frame.is-reading').count(), 1);
  assert.ok(await page.locator('.reading-badge').isVisible());
  assert.equal(await page.locator('.reading-robot').count(), 0);
  assert.doesNotMatch(await page.locator('.receipt-reading').textContent(), /秒）/);
  // The main button waits, and there is a way to stop waiting.
  assert.equal(await page.locator('.form-actions button[type=submit]').textContent(), '読み取り中…');
  assert.ok(await page.locator('.form-actions button[type=submit]').isDisabled());
  assert.ok(await page.getByRole('button', { name: '待たずに手で入力する', exact: true }).isEnabled());
  assert.ok(await page.getByRole('button', { name: 'AIで読み取る', exact: true }).isHidden(), 'The read button is hidden while reading');
  for (const id of ['#receipt-amount', '#receipt-merchant', '#receipt-date']) {
    assert.ok(await page.locator(id).isDisabled(), `${id} waits for the read`);
    assert.match(await page.locator(id).getAttribute('class'), /ai-pending/);
  }
  // The payment source is not filled by AI, so it can be chosen while waiting.
  assert.ok(await page.locator('#receipt-account').isEnabled());
  await page.locator('#receipt-account').selectOption({ label: 'Synthetic Wallet' });
  // Freeze the band over the middle of the photo so the screenshot shows the motion.
  if (process.env.PWA_RECEIPT_AI_READING_SCREENSHOT_PATH) {
    const pause = await page.addStyleTag({ content: '.receipt-preview-frame.is-reading::after { animation-delay: -0.9s !important; animation-play-state: paused !important; }' });
    await page.screenshot({ path: process.env.PWA_RECEIPT_AI_READING_SCREENSHOT_PATH });
    await pause.evaluate(node => node.remove());
  }
  held.gemini();
  await jevArrived;
  await page.locator('.reading-step.is-now').filter({ hasText: '品目をカテゴリに分けています' }).waitFor();
  assert.equal(await page.locator('.reading-step.is-done').count(), 2);
  assert.equal(await page.locator('.form-actions button[type=submit]').textContent(), '分類を待っています…');
  assert.equal(await page.getByRole('button', { name: '分類を待たずに自分で選ぶ', exact: true }).count(), 1);
  if (process.env.PWA_RECEIPT_AI_CATEGORIZING_SCREENSHOT_PATH) await page.locator('.receipt-reading').screenshot({ path: process.env.PWA_RECEIPT_AI_CATEGORIZING_SCREENSHOT_PATH });
  held.jev();
  await page.getByText(/読み取った内容は編集できます/).waitFor();
  assert.equal(await page.locator('.receipt-reading').count(), 0);
  assert.equal(await page.locator('.receipt-preview-frame.is-reading').count(), 0);
  assert.equal(await page.locator('#receipt-merchant').inputValue(), 'Synthetic Reading Shop');
  assert.doesNotMatch(await page.locator('#receipt-amount').getAttribute('class') ?? '', /ai-pending/);
  // The payment source chosen while waiting is kept after the read.
  assert.equal(await page.locator('#receipt-account option:checked').textContent(), 'Synthetic Wallet');

  // A failed read keeps the photo, offers trying again as the main action, and the retry reads it.
  autoRelease = true; failNext = true;
  await page.locator('#receipt-tab').click(); await click('記録を追加');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic-retry.png', mimeType: 'image/png', buffer: photo });
  await click('AIで読み取る');
  await page.locator('.reading-step.is-failed').filter({ hasText: '読み取れませんでした' }).waitFor();
  await page.getByText('ぼやけや反射があれば撮り直してください。', { exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: '撮り直す', exact: true }).isVisible());
  assert.ok(await page.locator('.form-actions button[type=submit]').isHidden());
  if (process.env.PWA_RECEIPT_AI_FAILED_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RECEIPT_AI_FAILED_SCREENSHOT_PATH });
  await click('もう一度読み取る');
  await page.waitForFunction(() => document.querySelector('#receipt-merchant')?.value === 'Synthetic Reading Shop');
  assert.equal(await page.locator('.reading-failure:not([hidden])').count(), 0);
  assert.ok(await page.locator('.form-actions button[type=submit]').isVisible());

  // Stopping the wait leaves the form to be filled by hand.
  await page.locator('#receipt-tab').click(); await click('記録を追加');
  autoRelease = false;
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic-wait.png', mimeType: 'image/png', buffer: photo });
  const waited = new Promise(resolve => { geminiSeen = resolve; });
  await click('AIで読み取る'); await waited;
  await click('待たずに手で入力する');
  await page.getByText('読み取りを待たずに入力できます。', { exact: false }).waitFor();
  assert.ok(await page.locator('#receipt-merchant').isEnabled());
  await page.locator('#receipt-merchant').fill('Synthetic Typed Shop');
  // The read still finishes in the background; what was typed stays.
  held.gemini();
  await page.waitForTimeout(800);
  assert.equal(await page.locator('#receipt-merchant').inputValue(), 'Synthetic Typed Shop');
  assert.deepEqual(errors, []);
  console.log('PASS: reading shows steps as rows with motion and placeholder bands (no timer or character), keeps the payment source selectable, offers retry after a failure, and can stop waiting without losing typed input.');
} finally {
  await browser.close();
}
