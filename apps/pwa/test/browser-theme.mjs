import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a dedicated preview or local PWA.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, colorScheme: 'light' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
async function appearance(theme) {
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), theme);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), theme === 'dark' ? 'rgb(23, 18, 14)' : 'rgb(250, 246, 241)');
  assert.equal(await page.locator('meta[name="theme-color"][media="all"]').getAttribute('data-theme'), theme);
}
async function openSettings() {
  await page.locator('#settings-tab').click();
  await page.getByRole('button', { name: '外観', exact: true }).click();
}
try {
  await page.goto(url);
  await page.getByText('今月の支出 ¥0').waitFor();
  await appearance('light');
  await openSettings();
  const select = page.getByLabel('表示モード', { exact: true });
  assert.equal(await select.inputValue(), 'system');
  assert.deepEqual(await select.locator('option').allTextContents(), ['ライト', 'ダーク', 'システム']);
  await page.emulateMedia({ colorScheme: 'dark' });
  await appearance('dark');
  await select.selectOption('light');
  await appearance('light');
  await page.reload();
  await page.getByText('今月の支出 ¥0').waitFor();
  await appearance('light');
  await openSettings();
  assert.equal(await select.inputValue(), 'light');
  await select.selectOption('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await appearance('dark');
  await mkdir('../../docs/screenshots', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await select.selectOption(theme);
    await appearance(theme);
    for (const width of [375, 1024, 1440]) {
      await page.setViewportSize({ width, height: 812 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (width === 375) await page.screenshot({ path: `../../docs/screenshots/theme-settings-${theme}-375.png`, fullPage: true });
    }
  }
  // Another tab changes the saved preference; this tab's controls and appearance follow it.
  const other = await context.newPage();
  await other.goto(url);
  await other.evaluate(() => localStorage.setItem('kakeimatch-theme', 'system'));
  await appearance('light');
  assert.equal(await select.inputValue(), 'system');
  await other.close();
  // Saved appearance is available on an offline restart, including the blocking bootstrap script.
  await select.selectOption('dark');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  await context.setOffline(true);
  await page.reload();
  await page.getByText('今月の支出 ¥0').waitFor();
  await appearance('dark');
  await context.setOffline(false);
  await page.evaluate(() => localStorage.setItem('kakeimatch-theme', 'invalid'));
  await page.reload();
  await appearance('light');
  await openSettings();
  assert.equal(await select.inputValue(), 'system');
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError'); }; });
  await select.selectOption('dark');
  await page.getByRole('status').filter({ hasText: '外観を保存できませんでした' }).waitFor();
  assert.equal(await select.inputValue(), 'system');
  await appearance('light');
  assert.deepEqual(errors, []);
  console.log('Theme settings E2E passed.');
} finally {
  await browser.close();
}
