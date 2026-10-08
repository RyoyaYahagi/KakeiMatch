import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-01T03:00:00Z'));
const errors = []; page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();
async function account(name) {
  await page.locator('#settings-tab').click(); await click('支払元'); await click('支払元を追加する');
  await page.getByLabel('支払元の名前', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: `${name} · 利用中`, exact: true }).waitFor();
}
async function category(name, income = false) {
  await page.locator('#settings-tab').click(); await click('カテゴリ'); if (income) await click('収入カテゴリ'); await click('カテゴリを追加する');
  await page.getByLabel('カテゴリ名', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).waitFor();
}
async function openChooser() { await page.locator('#home-tab').click(); await click('記録を追加'); }
async function save() { await click('登録する'); await page.getByText('登録しました。', { exact: true }).waitFor(); }
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await account('Synthetic Navigation Wallet'); await category('Synthetic Navigation Food'); await category('Synthetic Navigation Income', true);

  await openChooser();
  await page.getByRole('heading', { name: '何を記録しますか？' }).waitFor();
  assert.deepEqual(await page.locator('#record-sheet button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label') ?? button.textContent)),
    ['閉じる', 'レシートを撮る', '写真から', '支出を手入力', '収入', '口座間の振替']);
  assert.equal(await page.locator('#record-sheet input[type=file]').count(), 2);
  if (process.env.PWA_RECORD_NAVIGATION_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RECORD_NAVIGATION_SCREENSHOT_PATH, fullPage: true });
  await click('支出を手入力');
  await page.locator('#manual-transaction-payee').waitFor();
  // The category takes one row; every category is chosen in a sheet opened from "すべて".
  await click('すべてのカテゴリから選ぶ');
  await page.getByRole('radio', { name: 'Synthetic Navigation Food', exact: true }).click();
  await page.locator('.category-sheet').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.category-row-name').textContent(), 'Synthetic Navigation Food');
  assert.equal(await page.locator('#manual-transaction-category option:checked').textContent(), 'Synthetic Navigation Food');
  assert.equal(await page.getByRole('button', { name: 'キャンセル', exact: true }).count(), 1);
  await click('キャンセル');
  await page.getByRole('heading', { name: '何を記録しますか？' }).waitFor();
  await click('収入'); await page.locator('#manual-transaction-payee').waitFor(); await click('キャンセル');
  await page.getByRole('heading', { name: '何を記録しますか？' }).waitFor();
  await click('口座間の振替'); await page.getByLabel('振替先口座', { exact: true }).waitFor(); await click('キャンセル');
  await page.getByRole('heading', { name: '何を記録しますか？' }).waitFor();
  // Closing returns to the screen the chooser was opened from (here, home).
  await click('閉じる');
  await page.locator('#home-tab[aria-current="page"]').waitFor();
  // The sheet also closes with Escape and leaves the screen below as it was.
  await click('記録を追加'); await page.getByRole('heading', { name: '何を記録しますか？' }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#record-sheet').waitFor({ state: 'hidden' });
  await page.locator('#home-tab[aria-current="page"]').waitFor();
  await page.locator('#receipt-tab').click();

  // Observe every DOM update: waiting only for the final heading misses a settings flash.
  await page.evaluate(() => {
    window.accountNavigationScreens = [];
    window.accountNavigationObserver = new MutationObserver(() => {
      const settings = document.getElementById('settings-view');
      const masters = document.querySelector('.master-settings');
      if (!settings.hidden && masters.hidden) window.accountNavigationScreens.push('settings');
    });
    window.accountNavigationObserver.observe(document.body, { subtree: true, attributes: true, childList: true });
  });
  await click('口座・残高を見る');
  await page.getByRole('heading', { name: '支払元・口座' }).waitFor();
  assert.deepEqual(await page.evaluate(() => {
    window.accountNavigationObserver.disconnect();
    return window.accountNavigationScreens;
  }), [], 'records-to-accounts must not briefly display the settings root');
  if (process.env.PWA_ACCOUNT_NAVIGATION_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_ACCOUNT_NAVIGATION_SCREENSHOT_PATH, fullPage: true });
  await page.getByRole('button', { name: 'Synthetic Navigation Wallet · 利用中', exact: true }).waitFor();
  await page.locator('#settings-tab').click(); await click('支払元');
  await page.getByRole('heading', { name: '支払元・口座' }).waitFor();
  await page.locator('#receipt-tab').click(); await openChooser(); await click('収入');
  await page.locator('#manual-transaction-payee').fill('Synthetic Employer');
  await page.locator('#manual-transaction-amount').fill('1000');
  await page.locator('#manual-transaction-date').fill('2026-10-01');
  await page.locator('#manual-transaction-category').selectOption({ label: 'Synthetic Navigation Income' });
  await page.locator('#manual-transaction-account').selectOption({ label: 'Synthetic Navigation Wallet' });
  await save();
  await page.locator('#receipt-tab').click(); await page.getByRole('button', { name: /Synthetic Employer ·/ }).click();
  await page.getByRole('button', { name: /^金額を編集:/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: '編集する', exact: true }).count(), 0);
  await page.mouse.move(0, 0);
  if (process.env.PWA_RECORD_DETAIL_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_RECORD_DETAIL_SCREENSHOT_PATH, fullPage: true });
  for (const [label, field] of [['金額', 'amount'], ['日付', 'date'], ['入金元・内容', 'payee'], ['入金先口座', 'account'], ['メモ', 'memo']]) {
    await page.getByRole('button', { name: new RegExp(`^${label}を編集:`) }).click();
    const input = page.locator(`#manual-transaction-${field}`);
    await input.waitFor();
    assert.equal(await page.getByRole('heading', { name: '収入の記録', exact: true }).isVisible(), true);
    assert.equal(await page.locator('.transaction-detail').isVisible(), true);
    assert.equal(await page.getByRole('button', { name: '変更を保存する', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'キャンセル', exact: true }).count(), 0);
    assert.equal(await page.locator(`#manual-transaction-${field === 'amount' ? 'payee' : 'amount'}`).isVisible(), false);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await input.evaluate(node => node === document.activeElement), true);
    if (field === 'memo') {
      if (process.env.PWA_INLINE_DETAIL_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_INLINE_DETAIL_SCREENSHOT_PATH, fullPage: true });
      await input.fill('Synthetic tapped memo');
      await page.getByRole('heading', { name: '収入の記録', exact: true }).click();
      await page.getByRole('button', { name: 'メモを編集: Synthetic tapped memo', exact: true }).waitFor();
      assert.equal(await input.isVisible(), false);
      await click('変更を保存する');
      await page.getByText('変更を保存しました。', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'メモを編集: Synthetic tapped memo', exact: true }).waitFor();
    } else await page.getByRole('heading', { name: '収入の記録', exact: true }).click();
    await page.getByRole('heading', { name: '収入の記録', exact: true }).waitFor();
  }
  await page.getByRole('button', { name: /^カテゴリを編集:/ }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('radio', { name: 'Synthetic Navigation Income', exact: true }).waitFor();
  await page.keyboard.press('Escape'); await page.getByRole('heading', { name: '収入の記録', exact: true }).click();
  await page.getByRole('heading', { name: '収入の記録' }).waitFor();
  await page.getByRole('button', { name: /^金額を編集:/ }).click();
  await page.locator('#manual-transaction-amount').fill('1200');
  // Tapping another row closes the first without dropping the shared draft.
  await page.getByRole('button', { name: /^入金元・内容を編集:/ }).click();
  await page.locator('#manual-transaction-payee').fill('Synthetic Changed Employer');
  await page.getByRole('heading', { name: '収入の記録', exact: true }).click();
  await page.getByRole('button', { name: '金額を編集: ¥1,200', exact: true }).waitFor();
  await click('変更を保存する'); await page.getByText('変更を保存しました。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '入金元・内容を編集: Synthetic Changed Employer', exact: true }).waitFor();
  await page.getByRole('button', { name: '金額を編集: ¥1,200', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log('PASS: nested expense chooser, new-entry return targets, edit detail return, records-to-account-balances link, settings account management, and 375px horizontal overflow check');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; } finally { await browser.close(); }
