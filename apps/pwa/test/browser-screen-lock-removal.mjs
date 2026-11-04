import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a dedicated preview or local PWA.');

const lockKeys = [
  'kakeimatch.screen-lock.v1',
  'kakeimatch.screen-lock.v1.attempts',
  'kakeimatch.screen-lock.v1.event',
];

const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });

async function checkStartup(label, seed) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await context.addInitScript(() => { if ('serviceWorker' in navigator) navigator.serviceWorker.register = async () => ({}); });
  await context.addInitScript(seed);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(url);
    await page.getByText('今月の支出 ¥0', { exact: false }).waitFor();
    assert.equal(await page.locator('#screen-lock-overlay').count(), 0, `${label}: no lock screen is rendered`);
    assert.equal(await page.locator('#app-shell').evaluate(node => node.hidden), false, `${label}: the household UI is shown`);
    assert.equal(await page.evaluate(() => document.body.classList.contains('screen-locked')), false, `${label}: the page is not in a locked state`);
    const remaining = await page.evaluate(keys => keys.filter(key => localStorage.getItem(key) !== null), lockKeys);
    assert.deepEqual(remaining, [], `${label}: stored lock credentials are removed`);
    assert.equal(await page.evaluate(() => localStorage.getItem('kakeimatch.synthetic-setting')), 'keep', `${label}: unrelated settings are kept`);
    await page.locator('#settings-tab').click();
    assert.equal(await page.getByRole('button', { name: '画面ロック', exact: true }).count(), 0, `${label}: settings no longer offer a screen lock`);
    assert.deepEqual(pageErrors, [], `${label}: startup has no page errors`);
  } finally {
    await context.close();
  }
}

try {
  await checkStartup('enabled lock', () => {
    localStorage.setItem('kakeimatch.synthetic-setting', 'keep');
    localStorage.setItem('kakeimatch.screen-lock.v1', JSON.stringify({
      version: 1,
      pinSalt: 'c3ludGhldGljLXNhbHQ=',
      pinHash: 'c3ludGhldGljLWhhc2g=',
      recoverySalt: 'c3ludGhldGljLXJlY292ZXJ5LXNhbHQ=',
      recoveryHash: 'c3ludGhldGljLXJlY292ZXJ5LWhhc2g=',
      biometric: { credentialId: 'c3ludGhldGljLWNyZWRlbnRpYWw', publicKey: 'c3ludGhldGljLWtleQ==', algorithm: -7 },
    }));
    localStorage.setItem('kakeimatch.screen-lock.v1.attempts', JSON.stringify({ failedAttempts: 5, cooldownUntil: 4102444800000 }));
    localStorage.setItem('kakeimatch.screen-lock.v1.event', JSON.stringify({ type: 'lock', at: Date.now() }));
  });

  await checkStartup('malformed lock data', () => {
    localStorage.setItem('kakeimatch.synthetic-setting', 'keep');
    localStorage.setItem('kakeimatch.screen-lock.v1', '{not json');
    localStorage.setItem('kakeimatch.screen-lock.v1.attempts', 'not json');
    localStorage.setItem('kakeimatch.screen-lock.v1.event', 'not json');
  });

  console.log('PASS: a device with enabled or malformed screen lock data starts unlocked and the stored lock credentials are removed');
} finally {
  await browser.close();
}
