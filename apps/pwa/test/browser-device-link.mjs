import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// docs/UX.md 端末間の同期: two devices connect with text codes, compare households, and one adopts the other's.
if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
// Headless Chromium cannot resolve mDNS host names, so local candidates use plain loopback addresses here.
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
async function device() {
  // Separate contexts have separate storage, like two devices.
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Tokyo' });
  await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });
  await context.route('**/api/**', route => route.fulfill({ status: 403, json: { error: 'synthetic_signed_out' } }));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.PWA_E2E_URL); await page.getByText('今月の支出 ¥0').waitFor();
  return { page, errors };
}
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
async function openLink(page) { await page.locator('#settings-tab').click(); await click(page, 'ほかの端末と同期'); return page.getByRole('dialog', { name: 'ほかの端末と同期' }); }
async function textCode(dialog, label) {
  await dialog.getByText('文字のコードで渡す', { exact: true }).click();
  return dialog.getByLabel(`${label}（文字）`, { exact: true }).inputValue();
}

const first = await device();
const second = await device();
try {
  // The first device has one synthetic expense; the second is empty.
  const a = first.page;
  await a.locator('#settings-tab').click(); await click(a, '支払元'); await click(a, '支払元を追加する');
  await a.getByLabel('支払元の名前', { exact: true }).fill('Synthetic Link Wallet'); await click(a, '追加する');
  await a.getByRole('button', { name: 'Synthetic Link Wallet · 利用中', exact: true }).waitFor();
  await a.locator('#home-tab').click(); await click(a, '記録を追加'); await click(a, '支出を手入力');
  await a.locator('#manual-transaction-payee').fill('Synthetic Linked Expense');
  await a.locator('#manual-transaction-amount').fill('1234');
  await a.locator('#manual-transaction-category').selectOption({ label: '食費' });
  await a.locator('#manual-transaction-account').selectOption({ label: 'Synthetic Link Wallet' });
  await click(a, '登録する'); await a.getByText('登録しました。', { exact: true }).waitFor();

  // The first device shows its code; the second reads it as text and shows a reply.
  const dialogA = await openLink(a);
  await dialogA.getByRole('button', { name: 'この端末から始める', exact: true }).click();
  const offer = await textCode(dialogA, '最初のコード');
  assert.match(offer, /^KM1O\./);
  assert.equal(await dialogA.getByRole('img', { name: '最初のコード' }).count(), 1);
  if (process.env.PWA_DEVICE_LINK_SCREENSHOT_PATH) await a.screenshot({ path: process.env.PWA_DEVICE_LINK_SCREENSHOT_PATH });

  const b = second.page;
  const dialogB = await openLink(b);
  await dialogB.getByRole('button', { name: '相手の端末のコードを読む', exact: true }).click();
  // A code read at the wrong step is explained, not silently rejected.
  await dialogB.getByLabel('最初のコード', { exact: true }).fill(offer.replace('KM1O', 'KM1A'));
  await dialogB.getByRole('button', { name: '貼り付けたコードで続ける', exact: true }).click();
  await dialogB.getByText('これは返事のコードです。相手の端末で「この端末からつなぐ」を選んだ時のコードを読んでください。', { exact: true }).waitFor();
  await dialogB.getByLabel('最初のコード', { exact: true }).fill(offer);
  await dialogB.getByRole('button', { name: '貼り付けたコードで続ける', exact: true }).click();
  const answer = await textCode(dialogB, '返事のコード');
  assert.match(answer, /^KM1A\./);

  await dialogA.getByLabel('返事のコード', { exact: true }).fill(answer);
  await dialogA.getByRole('button', { name: '貼り付けたコードで続ける', exact: true }).click();

  // Both devices see both households.
  await dialogA.getByText('つながりました。どちらの家計簿にそろえますか？', { exact: true }).waitFor({ timeout: 20_000 });
  await dialogB.getByText('つながりました。どちらの家計簿にそろえますか？', { exact: true }).waitFor({ timeout: 20_000 });
  assert.match(await dialogA.locator('.device-link-households').innerText(), /この端末[\s\S]*取引1件[\s\S]*相手の端末[\s\S]*取引0件・取引なし/);
  if (process.env.PWA_DEVICE_LINK_CHOICE_SCREENSHOT_PATH) await a.screenshot({ path: process.env.PWA_DEVICE_LINK_CHOICE_SCREENSHOT_PATH });

  // Chosen on the first device, so the second asks before replacing its household.
  await dialogA.getByRole('button', { name: 'この端末の家計簿にそろえる', exact: true }).click();
  await dialogB.getByText('受け取った家計簿で、この端末の家計簿を置き換えますか？元の家計簿は「切り替え前の家計データに戻る」で戻せます。', { exact: true }).waitFor({ timeout: 30_000 });
  const reload = b.waitForEvent('load');
  await dialogB.getByRole('button', { name: '置き換える', exact: true }).click();
  await dialogA.getByText('相手の端末の家計簿を、この端末の家計簿にそろえました。', { exact: true }).waitFor({ timeout: 30_000 });
  await reload;
  await b.getByText('今月の支出', { exact: false }).first().waitFor();
  await b.locator('#receipt-tab').click();
  await b.getByRole('button', { name: /^Synthetic Linked Expense ·/ }).waitFor();
  // The previous household can still be restored on the device that was replaced.
  await b.locator('#settings-tab').click();
  assert.equal(await b.locator('#restore-previous').isDisabled(), false);
  assert.deepEqual([...first.errors, ...second.errors], []);
  console.log('PASS: two devices connect with text codes, explain a code read at the wrong step, compare households, and the replaced device confirms, adopts the other household, and can return to its previous one.');
} catch (error) {
  for (const { page } of [first, second]) console.log(await page.locator('body').innerText());
  throw error;
} finally { await browser.close(); }
