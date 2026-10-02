import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// docs/UX.md PCでの表示: the same screens with a side navigation and a centered chooser at 1024px and wider.
const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a dedicated preview or local PWA.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const errors = [];
async function check(width, height) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByText('今月の支出 ¥0').waitFor();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  const nav = await page.locator('nav.app-nav').boundingBox();
  const main = await page.locator('#household-view').boundingBox();
  assert.ok(nav && main);
  assert.equal(nav.x, 0, 'The side navigation sits on the left edge.');
  assert.equal(Math.round(nav.height), height, 'The side navigation spans the full height.');
  assert.ok(main.x >= nav.x + nav.width, 'The content starts to the right of the side navigation.');
  assert.equal(await overflow(), false);
  assert.deepEqual(await page.locator('nav .nav-button').allTextContents(), ['ホーム', '記録', '照合', '設定']);
  const add = page.getByRole('button', { name: '記録を追加', exact: true });
  assert.equal((await add.textContent())?.trim(), '記録を追加');
  const addBox = await add.boundingBox(); const homeBox = await page.locator('#home-tab').boundingBox();
  assert.ok(addBox && homeBox && addBox.y < homeBox.y, 'The add button comes first in the side navigation.');

  await add.click();
  const sheet = page.locator('#record-sheet');
  await sheet.getByRole('heading', { name: '何を記録しますか？' }).waitFor();
  const box = await sheet.boundingBox();
  assert.ok(box);
  assert.ok(Math.abs(box.x + box.width / 2 - width / 2) <= 1, 'The chooser opens in the middle of the screen.');
  assert.ok(box.y > 0 && box.y + box.height < height, 'The chooser does not stick to the bottom edge.');
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });

  for (const tab of ['#receipt-tab', '#reconciliation-tab', '#settings-tab']) {
    await page.locator(tab).click();
    assert.equal(await page.locator(tab).getAttribute('aria-current'), 'page');
    assert.equal(await overflow(), false, `${tab} has no horizontal scroll.`);
  }
  await context.close();
}
try {
  await check(1024, 768);
  await check(1440, 900);
  assert.deepEqual(errors, []);
  console.log('Desktop layout E2E passed.');
} finally {
  await browser.close();
}
