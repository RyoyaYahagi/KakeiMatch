import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a dedicated preview or local PWA.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { if ('serviceWorker' in navigator) navigator.serviceWorker.register = async () => ({}); });
const page = await context.newPage();
page.on('pageerror', error => console.error('pageerror:', error.message));
page.on('console', message => { if (message.type() === 'error') console.error('console:', message.text()); });
try {
  await page.goto(url);
  await page.getByText('今月の支出 ¥0', { exact: false }).waitFor();
  await page.locator('#settings-tab').click(); await page.getByRole('button', { name: '画面ロック', exact: true }).click();
  const settings = page.locator('.screen-lock-settings');
  await settings.waitFor();
  await page.getByRole('button', { name: '画面ロックを有効にする', exact: true }).click();
  await page.locator('#screen-lock-new-pin').fill('246810');
  await page.locator('#screen-lock-confirm-pin').fill('246810');
  const recoveryCode = await page.locator('.screen-lock-code').innerText();
  assert.match(recoveryCode, /^[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$/);
  await page.getByLabel('復旧コードを控えました').check();
  await page.getByRole('button', { name: '画面ロックを有効にする', exact: true }).last().click();
  await page.locator('#screen-lock-overlay:not([hidden])').waitFor();
  assert.equal(await page.locator('#app-shell').evaluate(node => node.hidden), true, 'the entire household UI is hidden under the lock screen');
  await page.evaluate(() => document.querySelector('#settings-tab').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.locator('#screen-lock-pin').fill('000000');
  await page.getByRole('button', { name: 'ロックを解除', exact: true }).click();
  await page.getByText('PINが違います。もう一度入力してください。').waitFor();
  await page.locator('#screen-lock-pin').fill('246810');
  await page.getByRole('button', { name: 'ロックを解除', exact: true }).click();
  await page.locator('#screen-lock-overlay[hidden]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#settings-view').evaluate(node => node.hidden), false, 'unlock returns to the screen which was already open');
  if (process.env.PWA_SCREEN_LOCK_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_SCREEN_LOCK_SCREENSHOT_PATH, fullPage: true });

  await page.locator('#settings-tab').click(); await page.getByRole('button', { name: '画面ロック', exact: true }).click();
  await settings.getByRole('button', { name: '今すぐロック', exact: true }).click();
  await page.locator('#screen-lock-overlay:not([hidden])').waitFor();
  if (process.env.PWA_SCREEN_LOCK_LOCKED_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_SCREEN_LOCK_LOCKED_SCREENSHOT_PATH });
  const secondPage = await context.newPage();
  await secondPage.clock.install();
  await secondPage.goto(url);
  await secondPage.locator('#screen-lock-overlay:not([hidden])').waitFor();
  await secondPage.locator('#screen-lock-pin').fill('246810');
  await secondPage.getByRole('button', { name: 'ロックを解除', exact: true }).click();
  await secondPage.locator('#screen-lock-overlay[hidden]').waitFor({ state: 'attached' });
  await secondPage.locator('#settings-tab').click(); await secondPage.getByRole('button', { name: '画面ロック', exact: true }).click();
  await secondPage.locator('.screen-lock-settings').getByLabel('現在のPIN').fill('000000');
  await secondPage.getByRole('button', { name: '画面ロックを無効にする', exact: true }).click();
  await secondPage.getByText('現在のPINが違います。', { exact: true }).waitFor();

  await secondPage.locator('.screen-lock-settings').getByLabel('現在のPIN').fill('246810');
  await secondPage.getByRole('button', { name: '画面ロックを無効にする', exact: true }).click();
  await secondPage.locator('.screen-lock-settings-status').getByText('無効です。', { exact: false }).waitFor();
  await page.locator('#screen-lock-overlay[hidden]').waitFor({ state: 'attached' });
  assert.equal(await secondPage.evaluate(() => localStorage.getItem('kakeimatch.screen-lock.v1')), null, 'disabling the lock only removes lock credentials');

  // Enable a fresh lock and use the offline recovery path; household storage remains untouched.
  await secondPage.getByRole('button', { name: '画面ロックを有効にする', exact: true }).click();
  await secondPage.locator('#screen-lock-new-pin').fill('135790');
  await secondPage.locator('#screen-lock-confirm-pin').fill('135790');
  const secondRecovery = await secondPage.locator('.screen-lock-code').innerText();
  await secondPage.getByLabel('復旧コードを控えました').check();
  await secondPage.getByRole('button', { name: '画面ロックを有効にする', exact: true }).last().click();
  await secondPage.locator('#screen-lock-overlay:not([hidden])').waitFor();
  await secondPage.locator('.screen-lock-recovery summary').click();
  await secondPage.locator('#screen-lock-recovery-code').fill(secondRecovery);
  await secondPage.getByRole('button', { name: 'ロックを解除して無効にする', exact: true }).click();
  await secondPage.locator('#screen-lock-overlay[hidden]').waitFor({ state: 'attached' });
  assert.equal(await secondPage.evaluate(() => localStorage.getItem('kakeimatch.screen-lock.v1')), null, 'recovery disables the lock instead of deleting household data');

  await secondPage.locator('#settings-tab').click(); await secondPage.getByRole('button', { name: '画面ロック', exact: true }).click();
  await secondPage.getByRole('button', { name: '画面ロックを有効にする', exact: true }).click();
  await secondPage.locator('#screen-lock-new-pin').fill('135790');
  await secondPage.locator('#screen-lock-confirm-pin').fill('135790');
  await secondPage.getByLabel('復旧コードを控えました').check();
  await secondPage.getByRole('button', { name: '画面ロックを有効にする', exact: true }).last().click();
  await secondPage.locator('#screen-lock-overlay:not([hidden])').waitFor();
  await secondPage.locator('#screen-lock-pin').fill('135790');
  await secondPage.getByRole('button', { name: 'ロックを解除', exact: true }).click();
  await secondPage.locator('#screen-lock-overlay[hidden]').waitFor({ state: 'attached' });
  await context.setOffline(true);
  await secondPage.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await secondPage.clock.fastForward(61_000);
  await secondPage.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await secondPage.locator('#screen-lock-overlay:not([hidden])').waitFor();
  await secondPage.locator('#screen-lock-pin').fill('135790');
  await secondPage.getByRole('button', { name: 'ロックを解除', exact: true }).click();
  await secondPage.locator('#screen-lock-overlay[hidden]').waitFor({ state: 'attached' });

  // Biometric unlock through a virtual platform authenticator; verification stays on the device.
  // WebAuthn rejects IP-address hosts, so this part uses a localhost origin with its own storage.
  await context.setOffline(false);
  const biometricUrl = new URL(url);
  if (biometricUrl.hostname === '127.0.0.1') biometricUrl.hostname = 'localhost';
  const biometricPage = await context.newPage();
  const cdp = await context.newCDPSession(biometricPage);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await biometricPage.goto(biometricUrl.href);
  await biometricPage.getByText('今月の支出 ¥0', { exact: false }).waitFor();
  await biometricPage.locator('#settings-tab').click(); await biometricPage.getByRole('button', { name: '画面ロック', exact: true }).click();
  const biometricSettings = biometricPage.locator('.screen-lock-settings');
  await biometricSettings.getByRole('button', { name: '画面ロックを有効にする', exact: true }).click();
  await biometricPage.locator('#screen-lock-new-pin').fill('135790');
  await biometricPage.locator('#screen-lock-confirm-pin').fill('135790');
  await biometricPage.getByLabel('復旧コードを控えました').check();
  await biometricPage.getByRole('button', { name: '画面ロックを有効にする', exact: true }).last().click();
  await biometricPage.locator('#screen-lock-overlay:not([hidden])').waitFor();
  assert.equal(await biometricPage.getByRole('button', { name: '生体認証で解除', exact: true }).count(), 0, 'biometric unlock is offered only after enrollment');
  await biometricPage.locator('#screen-lock-pin').fill('135790');
  await biometricPage.getByRole('button', { name: 'ロックを解除', exact: true }).click();
  await biometricPage.locator('#screen-lock-overlay[hidden]').waitFor({ state: 'attached' });
  await biometricSettings.getByLabel('現在のPIN').fill('000000');
  await biometricSettings.getByRole('button', { name: '生体認証も使う', exact: true }).click();
  await biometricPage.getByText('現在のPINが違います。', { exact: true }).waitFor();
  await biometricSettings.getByLabel('現在のPIN').fill('135790');
  await biometricSettings.getByRole('button', { name: '生体認証も使う', exact: true }).click();
  await biometricPage.getByText('生体認証で解除できるようにしました。', { exact: false }).waitFor();
  if (process.env.PWA_SCREEN_LOCK_BIOMETRIC_SETTINGS_SCREENSHOT_PATH) await biometricSettings.screenshot({ path: process.env.PWA_SCREEN_LOCK_BIOMETRIC_SETTINGS_SCREENSHOT_PATH });
  const stored = JSON.parse(await biometricPage.evaluate(() => localStorage.getItem('kakeimatch.screen-lock.v1')));
  assert.equal(stored.biometric.algorithm, -7, 'the device public key is stored for offline verification');
  assert.ok(stored.pinHash && !JSON.stringify(stored).includes('135790'), 'the PIN is still stored only as a hash');

  await context.setOffline(true);
  await biometricSettings.getByRole('button', { name: '今すぐロック', exact: true }).click();
  await biometricPage.locator('#screen-lock-overlay:not([hidden])').waitFor();
  if (process.env.PWA_SCREEN_LOCK_BIOMETRIC_SCREENSHOT_PATH) await biometricPage.screenshot({ path: process.env.PWA_SCREEN_LOCK_BIOMETRIC_SCREENSHOT_PATH });
  await biometricPage.getByRole('button', { name: '生体認証で解除', exact: true }).click();
  await biometricPage.locator('#screen-lock-overlay[hidden]').waitFor({ state: 'attached' });
  assert.equal(await biometricPage.locator('#settings-view').evaluate(node => node.hidden), false, 'biometric unlock returns to the open screen');

  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  await biometricSettings.getByRole('button', { name: '今すぐロック', exact: true }).click();
  await biometricPage.getByRole('button', { name: '生体認証で解除', exact: true }).click();
  await biometricPage.locator('#screen-lock-overlay .screen-lock-status').getByText('PINで解除', { exact: false }).waitFor();
  assert.equal(await biometricPage.locator('#app-shell').evaluate(node => node.hidden), true, 'failed biometric verification keeps the lock');
  await biometricPage.locator('#screen-lock-pin').fill('135790');
  await biometricPage.getByRole('button', { name: 'ロックを解除', exact: true }).click();
  await biometricPage.locator('#screen-lock-overlay[hidden]').waitFor({ state: 'attached' });

  await biometricSettings.getByLabel('現在のPIN').fill('135790');
  await biometricSettings.getByRole('button', { name: '生体認証をやめる', exact: true }).click();
  await biometricPage.getByText('生体認証での解除をやめました。', { exact: false }).waitFor();
  const withoutBiometric = JSON.parse(await biometricPage.evaluate(() => localStorage.getItem('kakeimatch.screen-lock.v1')));
  assert.equal(withoutBiometric.biometric, undefined, 'turning biometric off keeps the PIN lock');
  await biometricPage.close();
  console.log('PASS: explicit enable, launch and background relock, wrong/correct PIN, cross-tab lock, authenticated disable, recovery, biometric unlock and 375px layout');
  await secondPage.close();
} finally {
  await browser.close();
}
