import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Two tabs share one household. After one tab switches households (restore), the other tab must
// ask for a reload and must not write into the household it still shows. Synthetic data only.
const url = process.env.PWA_E2E_URL;
if (!url) throw new Error('Set PWA_E2E_URL to a synthetic-only local or preview PWA.');
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_no_cloud_account' } }));
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
const errors = [];
const syncState = page => page.evaluate(() => {
  const profileId = localStorage.getItem('kakeimatch.local-profile.v1');
  return { profileId, state: JSON.parse(localStorage.getItem(`kakeimatch.household-sync.v1:${profileId}`) ?? 'null') };
});
async function open() {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByText('今月の支出 ¥0', { exact: false }).waitFor();
  return page;
}
async function addAccount(page, name) {
  await page.locator('#settings-tab').click();
  await page.getByRole('button', { name: '支払元', exact: true }).click();
  await page.getByRole('button', { name: '支払元を追加する', exact: true }).click();
  await page.getByLabel('支払元の名前', { exact: true }).fill(name);
  await page.getByRole('button', { name: '追加する', exact: true }).click();
}

try {
  const first = await open();
  await addAccount(first, 'Synthetic Sync Wallet');
  await first.getByRole('button', { name: 'Synthetic Sync Wallet · 利用中', exact: true }).waitFor();
  const afterWrite = await syncState(first);
  assert.ok(afterWrite.state.changeCounter >= 1, 'an Actual write is counted as a household change');
  assert.equal(afterWrite.state.syncedCounter, 0);

  // A manual backup records its date on this device only; it is not a household change.
  await first.locator('#settings-tab').click();
  const downloadPromise = first.waitForEvent('download'); await first.locator('#backup-export').click();
  const buffer = await readFile(await (await downloadPromise).path());
  await first.getByText('バックアップを生成しました。Filesなどへの保存を確認してください。', { exact: true }).waitFor();
  assert.equal((await syncState(first)).state.changeCounter, afterWrite.state.changeCounter, 'a manual export is not counted');

  const second = await open();
  assert.equal((await syncState(second)).profileId, afterWrite.profileId);

  // The first tab restores the backup into a new household and switches to it.
  const navigation = first.waitForNavigation({ waitUntil: 'load' }); first.once('dialog', dialog => dialog.accept());
  await first.locator('#backup-file').setInputFiles({ name: 'synthetic-sync.kmb', mimeType: 'application/vnd.kakeimatch.backup', buffer });
  await navigation;
  const switched = await syncState(first);
  assert.notEqual(switched.profileId, afterWrite.profileId);

  // The second tab still shows the old household. It asks for a reload and refuses to write.
  await second.getByText('別の画面で家計データが切り替わりました。最新の内容を表示するには再読み込みしてください。', { exact: false }).waitFor();
  await addAccount(second, 'Synthetic Stale Wallet');
  await second.getByText('別の画面で家計データが切り替わりました。このページを再読み込みしてから操作してください。', { exact: false }).waitFor();
  const stale = await second.evaluate(id => JSON.parse(localStorage.getItem(`kakeimatch.household-sync.v1:${id}`) ?? 'null'), afterWrite.profileId);
  assert.equal(stale.changeCounter, afterWrite.state.changeCounter, 'the refused write is not counted');

  const reload = second.waitForNavigation({ waitUntil: 'load' });
  await second.getByRole('button', { name: '再読み込み', exact: true }).click();
  await reload;
  await second.getByText('今月の支出 ¥0', { exact: false }).waitFor();
  await second.locator('#settings-tab').click();
  await second.getByRole('button', { name: '支払元', exact: true }).click();
  await second.getByRole('button', { name: 'Synthetic Sync Wallet · 利用中', exact: true }).waitFor();
  assert.equal(await second.getByRole('button', { name: 'Synthetic Stale Wallet · 利用中', exact: true }).count(), 0, 'nothing was written by the stale tab');
  assert.deepEqual(errors, []);
  console.log('PASS: household writes are counted (manual export is not), and a tab left behind by a household switch asks for a reload and writes nothing.');
} finally {
  await browser.close();
}
