import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { waitForBackupExportReady } from './backup-e2e-helpers.mjs';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, acceptDownloads: true });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-01T03:00:00Z'));
const errors = []; page.on('pageerror', error => errors.push(error.message));
const syntheticImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64');
let geminiScenario = 'known';
const jevRequests = [];
let learningIds;
let receiptClockTick = 0;
await context.route('**/api/ai/token', route => route.fulfill({ json: { token: 'synthetic-token', expiresAt: 9999999999 } }));
await context.route('**/api/ai/gemini', route => {
  const items = geminiScenario === 'unknown'
    ? [{ name: 'Synthetic Same Milk', amountYen: 500 }, { name: 'Synthetic Unknown Cable', amountYen: 1000 }]
    : [{ name: 'Synthetic Same Milk', amountYen: 500 }, { name: 'Synthetic Same Soap', amountYen: 1000 }];
  return route.fulfill({ json: { documentKind: 'receipt', merchant: 'Synthetic Learning Shop', purchasedDate: '2026-10-01', purchasedTime: null, totalAmountYen: 1500, taxAmountYen: null, items, adjustments: [], warnings: [] } });
});
await context.route('**/api/ai/jev', route => {
  const body = route.request().postDataJSON(); jevRequests.push(body);
  const categories = body.categories;
  const electronicId = learningIds?.electronic;
  const foodId = learningIds?.food;
  const answers = Object.fromEntries((body.itemIndexes ?? []).map(index => {
    const item = body.receipt.items[index];
    const chosen = item.name.includes('Cable') ? electronicId : foodId;
    return [`item_${index}`, { type: 'choice', choice: chosen, confidence: 1, probabilities: Object.fromEntries(categories.map(category => [category.id, category.id === chosen ? 1 : 0])) }];
  }));
  return route.fulfill({ json: { model: 'synthetic-category-model', answers } });
});
const click = name => page.getByRole('button', { name, exact: true }).click();
const itemRow = index => page.locator('[data-receipt-item]').nth(index);
async function settings(label) { await page.locator('#settings-tab').click(); await click(label); }
async function addAccount(name) {
  await settings('支払元'); await click('支払元を追加する'); await page.getByLabel('支払元の名前', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: `${name} · 利用中`, exact: true }).waitFor();
}
async function addCategory(name) {
  await settings('カテゴリ'); await click('カテゴリを追加する'); await page.getByLabel('カテゴリ名', { exact: true }).fill(name); await click('追加する');
  await page.getByRole('button', { name: new RegExp(`^${name} ·`) }).waitFor();
}
async function startReceipt() {
  await page.clock.setFixedTime(new Date(Date.parse('2026-10-01T03:00:00Z') + receiptClockTick++ * 60_000));
  await page.locator('#receipt-tab').click(); await click('記録を追加');
  await page.locator('#record-sheet input[type=file]').first().setInputFiles({ name: 'synthetic-learning.png', mimeType: 'image/png', buffer: syntheticImage });
  await page.waitForFunction(() => ['Synthetic Learning Food', 'Synthetic Learning Home', 'Synthetic Learning Electronic'].every(name => [...(document.querySelector('#receipt-category')?.options ?? [])].some(option => option.textContent?.includes(name))));
}
async function addLearningItems() {
  let index = 0;
  for (const [name, amount, category] of [['Synthetic Same Milk', '500', 'Synthetic Learning Food'], ['Synthetic Same Soap', '1000', 'Synthetic Learning Home']]) {
    await page.locator('#receipt-merchant').focus(); await click('品目を追加');
    const item = itemRow(index++); await item.waitFor(); if (await item.getAttribute('open') === null) await item.locator('summary').click();
    await item.locator('[data-item-name]').fill(name); await item.locator('[data-item-amount]').fill(amount);
    await item.locator('[data-item-category]').selectOption({ label: category });
  }
}
async function register() { await click('登録する'); await page.waitForFunction(() => document.querySelector('#message')?.textContent === '登録しました。'); }
async function analyze(scenario) {
  geminiScenario = scenario; await startReceipt(); await click('AIで読み取る');
  await page.waitForFunction(() => document.querySelector('#receipt-merchant')?.value === 'Synthetic Learning Shop'
    && document.querySelectorAll('[data-receipt-item]').length === 2
    && document.querySelectorAll('[data-receipt-item] [data-item-category]').length === 2);
}
async function readLearningAudits() {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kakeimatch-local-data'); open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result; const request = db.transaction('records', 'readonly').objectStore('records').getAll();
      request.onsuccess = () => {
        const profileId = localStorage.getItem('kakeimatch.local-profile.v1');
        resolve(request.result.filter(row => row.profileId === profileId && row.kind === 'correction-audit' && row.value.targetType === 'category-learning').map(row => row.value)); db.close();
      };
      request.onerror = () => reject(request.error);
    };
  }));
}
async function optionValue(selector, label) {
  return page.locator(`${selector} option`).evaluateAll((options, target) => options.find(option => option.textContent?.includes(target))?.value ?? '', label);
}
async function cancelDraft() { await click('キャンセル'); await click('閉じる'); }
try {
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  await addAccount('Synthetic Learning Wallet');
  await addCategory('Synthetic Learning Food'); await addCategory('Synthetic Learning Home'); await addCategory('Synthetic Learning Electronic');

  const voteDates = ['2026-09-28', '2026-09-29', '2026-09-30'];
  for (const date of voteDates) {
    await startReceipt();
    if (!learningIds) {
      learningIds = {
        food: await optionValue('#receipt-category', 'Synthetic Learning Food'),
        home: await optionValue('#receipt-category', 'Synthetic Learning Home'),
        electronic: await optionValue('#receipt-category', 'Synthetic Learning Electronic'),
      };
      assert.ok(learningIds.food && learningIds.home && learningIds.electronic);
    }
    await page.locator('#receipt-merchant').fill('Synthetic Learning Shop');
    await page.locator('#receipt-date').fill(date); await page.locator('#receipt-amount').fill('1500');
    await page.locator('#receipt-category').selectOption({ label: 'Synthetic Learning Food' });
    await page.locator('#receipt-account').selectOption({ label: 'Synthetic Learning Wallet' });
    await addLearningItems(); await register();
  }
  let audits = await readLearningAudits();
  assert.equal(audits.length, 3);
  assert.equal(new Set(audits.map(audit => audit.receiptId)).size, 3);
  assert.ok(audits.every(audit => audit.merchantCategoryId === null));
  assert.ok(audits.every(audit => audit.items.some(item => item.normalizedName === 'synthetic same milk' && item.categoryId === learningIds.food)));
  assert.ok(audits.every(audit => audit.items.some(item => item.normalizedName === 'synthetic same soap' && item.categoryId === learningIds.home)));
  assert.equal(jevRequests.length, 0);
  await page.getByRole('button', { name: /^Synthetic Learning Shop · 9\/28 · .*レシート/ }).click();
  assert.equal(await page.getByText('分類の理由', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '記録一覧へ戻る' }).click();

  // Both item rules resolve locally; no Jev request is needed for known items.
  await analyze('known');
  assert.equal(await itemRow(0).locator('[data-item-category]').inputValue(), learningIds.food);
  assert.equal(await itemRow(1).locator('[data-item-category]').inputValue(), learningIds.home);
  await page.getByText('いつもの分類を適用しました。', { exact: true }).waitFor();
  assert.equal(jevRequests.length, 0);
  await cancelDraft();

  // Users can inspect the learned evidence and override or disable an item rule.
  await settings('分類ルール');
  const milkRule = page.locator('.category-rule').filter({ hasText: 'synthetic same milk' });
  await milkRule.locator('summary').click();
  await milkRule.getByText(/根拠: 3件 \/ 3件 · 一致率 100%/).waitFor();
  await page.screenshot({ path: process.env.PWA_CATEGORY_RULES_SCREENSHOT_PATH ?? '/tmp/issue-157-category-rules.png', fullPage: true });
  await milkRule.locator('select').selectOption(learningIds.home);
  await milkRule.getByRole('button', { name: 'カテゴリを変更' }).click();
  await page.getByText('分類を変更しました。', { exact: true }).waitFor();
  await milkRule.locator('summary').click();
  await milkRule.locator('input[role=switch]').uncheck();
  await analyze('known');
  assert.deepEqual(jevRequests.at(-1).itemIndexes, [0]);
  await cancelDraft();
  await settings('分類ルール');
  const updatedMilkRule = page.locator('.category-rule').filter({ hasText: 'synthetic same milk' });
  await updatedMilkRule.locator('summary').click();
  await updatedMilkRule.locator('input[role=switch]').check();
  await updatedMilkRule.locator('summary').click();
  await updatedMilkRule.locator('select').selectOption(learningIds.food);
  await updatedMilkRule.getByRole('button', { name: 'カテゴリを変更' }).click();
  await page.getByText('分類を変更しました。', { exact: true }).waitFor();

  // A known item is omitted from Jev, but the unknown item receives native category IDs.
  await analyze('unknown');
  assert.equal(await itemRow(0).locator('[data-item-category]').inputValue(), learningIds.food);
  assert.equal(await itemRow(1).locator('[data-item-category]').inputValue(), learningIds.electronic);
  assert.deepEqual(jevRequests.at(-1).itemIndexes, [1]);
  assert.equal(jevRequests.at(-1).receipt.items.length, 2);
  for (const id of Object.values(learningIds)) assert.ok(jevRequests.at(-1).categories.some(category => category.id === id));
  await page.screenshot({ path: process.env.PWA_CATEGORY_LEARNING_SCREENSHOT_PATH ?? '/tmp/issue-79-category-learning.png', fullPage: true });
  // A one-receipt override makes Milk 3:1 (75%), below the 80% agreement threshold.
  await page.locator('#receipt-category').selectOption(learningIds.food);
  if (await itemRow(0).getAttribute('open') === null) await itemRow(0).locator('summary').click();
  await itemRow(0).locator('[data-item-category]').selectOption(learningIds.home);
  await register();
  await page.getByRole('button', { name: /^Synthetic Learning Shop · 10\/1 · .*レシート/ }).click();
  const classificationReason = page.locator('details').filter({ has: page.getByText('分類の理由', { exact: true }) });
  await classificationReason.locator('summary').click();
  await classificationReason.getByText('品目「synthetic same milk」→「Synthetic Learning Food」で分類しました。', { exact: true }).waitFor();
  await classificationReason.getByText('適用時は過去3件中3件が「Synthetic Learning Food」でした（一致率 100%）。', { exact: true }).waitFor();
  await page.screenshot({ path: process.env.PWA_CATEGORY_EXPLANATION_SCREENSHOT_PATH ?? '/tmp/issue-157-category-explanation.png', fullPage: true });
  await page.getByRole('button', { name: '記録一覧へ戻る' }).click();
  audits = await readLearningAudits(); assert.equal(audits.length, 4);
  assert.equal(new Set(audits.map(audit => audit.receiptId)).size, 4);
  assert.ok(audits.every(audit => audit.merchantCategoryId === null));

  const requestCountBeforeEditedRule = jevRequests.length;
  await analyze('known');
  assert.equal(jevRequests.length, requestCountBeforeEditedRule + 1);
  assert.deepEqual(jevRequests.at(-1).itemIndexes, [0]);
  assert.equal(await itemRow(0).locator('[data-item-category]').inputValue(), learningIds.food);
  assert.equal(await itemRow(1).locator('[data-item-category]').inputValue(), learningIds.home);
  await cancelDraft();

  // Portable backup/restore must retain local item votes and their native category IDs.
  await page.locator('#settings-tab').click();
  const downloadPromise = page.waitForEvent('download'); await page.locator('#backup-export').click();
  const download = await downloadPromise; const file = await download.path(); assert.ok(file); const buffer = await readFile(file);
  await waitForBackupExportReady(page);
  const navigation = page.waitForNavigation({ waitUntil: 'load' }); page.once('dialog', dialog => dialog.accept());
  await page.locator('#backup-file').setInputFiles({ name: 'synthetic-category-learning.kmb', mimeType: 'application/vnd.kakeimatch.backup', buffer });
  await navigation; await page.getByText('今月の支出 ¥1,500', { exact: false }).waitFor();
  audits = await readLearningAudits(); assert.equal(audits.length, 4);
  const requestCountBeforeRestoreCheck = jevRequests.length;
  await analyze('known'); assert.equal(jevRequests.length, requestCountBeforeRestoreCheck + 1);
  assert.deepEqual(jevRequests.at(-1).itemIndexes, [0]);
  await cancelDraft();

  // Editing one receipt replaces that receipt's vote instead of adding another vote.
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: /^Synthetic Learning Shop · 9\/28 · .*レシート/ }).click();
  await click('編集する'); await page.locator('#receipt-merchant').waitFor();
  for (const [index, categoryId] of [learningIds.home, learningIds.food].entries()) {
    await page.locator('#receipt-merchant').focus();
    if (await itemRow(index).getAttribute('open') === null) await itemRow(index).locator('summary').click();
    await itemRow(index).locator('[data-item-category]').selectOption(categoryId);
  }
  await click('変更を保存する'); await page.getByText('変更を保存しました。', { exact: true }).waitFor();
  audits = await readLearningAudits();
  assert.equal(audits.length, 4); assert.equal(new Set(audits.map(audit => audit.receiptId)).size, 4);
  assert.equal(audits.filter(audit => audit.items.some(item => item.normalizedName === 'synthetic same milk' && item.categoryId === learningIds.home)
    && audit.items.some(item => item.normalizedName === 'synthetic same soap' && item.categoryId === learningIds.food)).length, 1);
  assert.ok(audits.every(audit => audit.merchantCategoryId === null));
  await page.reload(); await page.getByText('今月の支出 ¥1,500', { exact: false }).waitFor();
  await context.setOffline(true);
  assert.equal((await readLearningAudits()).length, 4);
  await page.locator('#receipt-tab').click();
  await page.getByRole('button', { name: /^Synthetic Learning Shop · 9\/28 · .*レシート/ }).click();
  await click('編集する');
  for (let index = 0; index < 2; index++) {
    if (await itemRow(index).getAttribute('open') === null) await itemRow(index).locator('summary').click();
  }
  assert.equal(await itemRow(0).locator('[data-item-category]').inputValue(), learningIds.home);
  assert.equal(await itemRow(1).locator('[data-item-category]').inputValue(), learningIds.food);
  await click('キャンセル');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []); await context.setOffline(false);
  await settings('分類ルール');
  page.once('dialog', dialog => dialog.accept());
  await click('すべての変更をリセット');
  await page.getByText('分類ルールへの変更をリセットしました。', { exact: true }).waitFor();
  const overrideCount = await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kakeimatch-local-data'); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result; const request = db.transaction('records', 'readonly').objectStore('records').getAll();
      request.onsuccess = () => { const profileId = localStorage.getItem('kakeimatch.local-profile.v1'); resolve(request.result.filter(row => row.profileId === profileId && row.id.startsWith('category-rule-override:')).length); db.close(); };
      request.onerror = () => reject(request.error); };
  }));
  assert.equal(overrideCount, 0);
  await analyze('known'); assert.deepEqual(jevRequests.at(-1).itemIndexes, [0, 1]); await cancelDraft();
  console.log('PASS: item and merchant rules, disable and override, Jev unresolved items, backup/restore, reset, 75% fallback, and one-receipt-one-vote editing');
} catch (error) { console.log(await page.locator('body').innerText()); throw error; } finally { await browser.close(); }
