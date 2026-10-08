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
  // Cancelling an uncertain save leaves the fixed draft and identity intact.
  const pendingDraft = await page.evaluate(() => window.manualRetry.records.get('manual-draft:income:new'));
  const cancel = page.getByRole('button', { name: 'キャンセル', exact: true });
  assert.equal(await cancel.isEnabled(), true, 'An unknown save result must still allow cancelling the editor');
  await cancel.click();
  await page.waitForFunction(() => window.manualRetry.state.cancels === 1);
  assert.deepEqual(await page.evaluate(() => window.manualRetry.records.get('manual-draft:income:new')), pendingDraft);
  await page.evaluate(() => window.manualRetry.open());
  await page.getByRole('button', { name: '同じ内容で再試行する', exact: true }).waitFor();
  assert.equal(await cancel.isEnabled(), true, 'A restored failed draft must allow cancelling');
  assert.equal(await page.locator('#manual-transaction-amount').isDisabled(), true);
  await cancel.click();
  await page.waitForFunction(() => window.manualRetry.state.cancels === 2);
  assert.deepEqual(await page.evaluate(() => window.manualRetry.records.get('manual-draft:income:new')), pendingDraft);
  await page.evaluate(() => window.manualRetry.open());
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
  await page.getByRole('button', { name: '同じ内容で再試行する', exact: true }).waitFor();
  assert.equal(await cancel.isEnabled(), true, 'A restored processing draft must allow cancelling');
  await page.getByRole('button', { name: '同じ内容で再試行する', exact: true }).click();
  await page.waitForFunction(() => window.manualRetry.state.saves === 2);
  assert.equal(await page.evaluate(() => window.manualRetry.rows.length), 2);
  assert.equal(await page.evaluate(() => window.manualRetry.records.size), 0);
  // An already saved row can differ after a rule or a later edit. Repeating
  // the same write must not trap the user indefinitely or overwrite that row.
  await page.evaluate(() => window.manualRetry.open());
  await page.locator('#manual-transaction-payee').fill('合成給与');
  await page.locator('#manual-transaction-amount').fill('18000');
  await page.locator('#manual-transaction-date').fill('2026-10-03');
  await page.locator('#manual-transaction-category').selectOption('income');
  await page.locator('#manual-transaction-account').selectOption('bank');
  await page.evaluate(() => { window.manualRetry.state.failReadback = true; });
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await page.getByRole('button', { name: '同じ内容で再試行する', exact: true }).waitFor();
  await page.evaluate(() => { window.manualRetry.rows.at(-1).amount = 17000; });
  await page.getByRole('button', { name: '同じ内容で再試行する', exact: true }).click();
  await page.getByRole('button', { name: '登録済みの内容で完了する', exact: true }).waitFor().catch(async error => { console.log(await page.locator('[role=status]').innerText()); throw error; });
  assert.match(await page.locator('[data-saved-result]').innerText(), /17,000/);
  assert.equal(await page.evaluate(() => window.manualRetry.rows.length), 3);
  if (process.env.PWA_MANUAL_RECOVERY_SCREENSHOT_PATH) {
    await mkdir(dirname(process.env.PWA_MANUAL_RECOVERY_SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: process.env.PWA_MANUAL_RECOVERY_SCREENSHOT_PATH, fullPage: true });
  }
  // A concurrent change must be shown and confirmed again before discarding
  // the pending draft. Failure to clear the draft also remains recoverable.
  await page.evaluate(() => { window.manualRetry.rows.at(-1).amount = 16000; });
  await page.getByRole('button', { name: '登録済みの内容で完了する', exact: true }).click();
  await page.getByText('登録済みの内容が変わりました。表示された内容を確認してください。', { exact: true }).waitFor();
  assert.match(await page.locator('[data-saved-result]').innerText(), /16,000/);
  assert.equal(await page.evaluate(() => window.manualRetry.state.saves), 2);
  await page.evaluate(() => { window.manualRetry.state.failCleanup = true; });
  await page.getByRole('button', { name: '登録済みの内容で完了する', exact: true }).click();
  await page.getByText('保存できませんでした。入力内容を確認してもう一度お試しください。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.manualRetry.records.size), 1);
  await page.getByRole('button', { name: '登録済みの内容で完了する', exact: true }).click();
  await page.waitForFunction(() => window.manualRetry.state.saves === 3);
  assert.equal(await page.evaluate(() => window.manualRetry.records.size), 0);
  assert.equal(await page.evaluate(() => window.manualRetry.rows.at(-1).amount), 16000);
  // A failure before any import must become editable once absence is verified,
  // preserving the identity rather than starting another transaction.
  await page.evaluate(() => window.manualRetry.open());
  await page.locator('#manual-transaction-payee').fill('合成給与');
  await page.locator('#manual-transaction-amount').fill('19000');
  await page.locator('#manual-transaction-date').fill('2026-10-04');
  await page.locator('#manual-transaction-category').selectOption('income');
  await page.locator('#manual-transaction-account').selectOption('bank');
  await page.evaluate(() => { window.manualRetry.state.failImport = true; });
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await page.getByRole('button', { name: '同じ内容で再試行する', exact: true }).waitFor();
  const absentDraft = await page.evaluate(() => window.manualRetry.records.get('manual-draft:income:new'));
  await page.evaluate(() => { window.manualRetry.state.failReads = true; });
  await page.getByRole('button', { name: '同じ内容で再試行する', exact: true }).click();
  await page.getByText('保存結果をまだ確認できません。下書きを保持しています。もう一度再試行してください。', { exact: true }).waitFor();
  assert.equal(await page.locator('#manual-transaction-amount').isDisabled(), true);
  assert.equal(await cancel.isEnabled(), true);
  assert.equal(await page.evaluate(() => window.manualRetry.rows.length), 3);
  await page.evaluate(() => { window.manualRetry.state.failReads = false; });
  await page.getByRole('button', { name: '同じ内容で再試行する', exact: true }).click();
  await page.getByText('未登録であることを確認しました。入力内容を修正して登録できます。', { exact: true }).waitFor();
  assert.equal(await page.locator('#manual-transaction-amount').isEnabled(), true);
  assert.equal(await page.locator('#manual-transaction-payee').isEnabled(), true);
  assert.equal(await page.evaluate(() => window.manualRetry.records.get('manual-draft:income:new').value.manualImportedId), absentDraft.value.manualImportedId);
  await page.locator('#manual-transaction-amount').fill('20000');
  await page.evaluate(() => { window.manualRetry.state.failImport = false; });
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await page.waitForFunction(() => window.manualRetry.state.saves === 4);
  assert.equal(await page.evaluate(() => window.manualRetry.rows.length), 4);
  assert.equal(await page.evaluate(() => window.manualRetry.rows.at(-1).amount), 20000);
  assert.equal(await page.evaluate(() => window.manualRetry.rows.at(-1).imported_id), absentDraft.value.manualImportedId);
  assert.equal(await page.evaluate(() => window.manualRetry.records.size), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: uncertain income saves recover matching, changed, absent and unreadable results without duplicates or overwrites');
} finally { await browser.close(); }
