import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  configFile: false,
  root: appRoot,
  logLevel: 'error',
  resolve: { alias: { '@': resolve(appRoot, 'src') } },
  build: {
    write: false,
    emptyOutDir: false,
    minify: false,
    lib: { entry: resolve(appRoot, 'test/master-navigation-failure.ts'), name: 'MasterNavigationFailureHarness', formats: ['iife'], fileName: 'harness' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
const html = (await readFile(resolve(appRoot, 'test/master-navigation-failure.html'), 'utf8'))
  .replace(/\s*<link rel="stylesheet" href="\/src\/style\.css">/, `<style>${await readFile(resolve(appRoot, 'src/style.css'), 'utf8')}</style>`)
  .replace(/\s*<script type="module" src="\/test\/master-navigation-failure\.ts"><\/script>/, '');
const outputs = Array.isArray(bundle) ? bundle.flatMap(result => result.output) : bundle.output;
const script = outputs.find(output => output.type === 'chunk')?.code;
if (!script) throw new Error('Could not bundle the synthetic master UI harness.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));

async function settingsTop() {
  if (await page.locator('.master-settings').isVisible()) await page.getByRole('button', { name: '設定へ戻る' }).click();
}
async function showSettingsError(expected) {
  const status = page.locator('[data-master-settings-status]');
  await status.getByText(expected, { exact: true }).waitFor();
  assert.equal(await status.isVisible(), true);
  if (expected === '合成カテゴリ一覧の取得に失敗しました。' && process.env.PWA_MASTER_FAILURE_SCREENSHOT_PATH) {
    await mkdir(dirname(process.env.PWA_MASTER_FAILURE_SCREENSHOT_PATH), { recursive: true });
    await page.screenshot({ path: process.env.PWA_MASTER_FAILURE_SCREENSHOT_PATH, fullPage: false });
  }
}
async function retryCategoryAfter(flag, expected) {
  await settingsTop();
  await page.evaluate(key => { window.masterNavigationFailureState[key] = true; }, flag);
  await page.getByRole('button', { name: 'カテゴリ', exact: true }).click();
  await showSettingsError(expected);
  await page.evaluate(key => { window.masterNavigationFailureState[key] = false; }, flag);
  await page.getByRole('button', { name: 'カテゴリ', exact: true }).click();
  await page.getByRole('button', { name: /^合成カテゴリ ·/ }).waitFor();
  assert.equal(await page.locator('[data-master-settings-status]').isHidden(), true);
}

try {
  await page.setContent(html);
  await page.addScriptTag({ content: script });
  await page.getByRole('button', { name: 'カテゴリ', exact: true }).waitFor();

  await retryCategoryAfter('failCategories', '合成カテゴリ一覧の取得に失敗しました。');
  await retryCategoryAfter('failCategoryUsage', '合成カテゴリ利用数の取得に失敗しました。');

  await settingsTop();
  await page.evaluate(() => { window.masterNavigationFailureState.failAccountBalances = true; });
  await page.getByRole('button', { name: '支払元', exact: true }).click();
  await showSettingsError('合成口座残高の取得に失敗しました。');
  await page.evaluate(() => { window.masterNavigationFailureState.failAccountBalances = false; });
  await page.getByRole('button', { name: '支払元', exact: true }).click();
  await page.locator('.account-total').waitFor();

  await settingsTop();
  await page.evaluate(() => { window.masterNavigationFailureState.failProvider = true; });
  await page.getByRole('button', { name: '支払元', exact: true }).click();
  await showSettingsError('合成明細サービスの取得に失敗しました。');
  await page.evaluate(() => { window.masterNavigationFailureState.failProvider = false; });
  await page.getByRole('button', { name: '支払元', exact: true }).click();
  await page.locator('.account-total').waitFor();

  await settingsTop();
  await page.evaluate(() => { window.masterNavigationFailureState.deferCategories = true; });
  await page.getByRole('button', { name: 'カテゴリ', exact: true }).click();
  await page.waitForFunction(() => typeof window.masterNavigationFailureState.rejectCategories === 'function');
  await page.getByRole('button', { name: '支払元', exact: true }).click();
  await page.locator('.account-total').waitFor();
  await page.evaluate(() => window.masterNavigationFailureState.rejectCategories(new Error('古いカテゴリ画面の合成エラーです。')));
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.page-title').textContent(), '支払元・口座');
  assert.equal(await page.locator('.master-settings [data-master-status]').textContent(), '');
  assert.equal(await page.locator('[data-master-settings-status]').textContent(), '');
  assert.deepEqual(errors, []);

  console.log('master navigation failure E2E passed: visible retry for category/account failures and stale failure suppression');
} finally {
  await context.close();
  await browser.close();
}
