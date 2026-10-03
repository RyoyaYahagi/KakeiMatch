import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const assetRoot = fileURLToPath(new URL('../.cloudflare/output/v0/workers/default/assets/', import.meta.url));
const template = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const html = await readFile(`${assetRoot}index.html`, 'utf8');
const assets = JSON.parse(await readFile(`${assetRoot}offline-assets.json`, 'utf8'));
let deployment = 'old';
let failNew = false;
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  try {
    if (path === '/sw.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(template.replaceAll('__KM_BUILD__', deployment)); return; }
    if (path.startsWith('/api/')) { response.setHeader('Content-Type', 'application/json'); response.end('null'); return; }
    if (path === `/offline-assets-${deployment}.json`) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ build: deployment, assets: [...assets, `/assets/generation-${deployment}.js`] })); return;
    }
    if (/^\/assets\/generation-(old|new)\.js$/.test(path)) {
      if (failNew && path.endsWith('new.js')) { response.statusCode = 503; response.end('synthetic download failure'); return; }
      response.setHeader('Content-Type', 'text/javascript'); response.end(`window.syntheticBuild = '${deployment}';`); return;
    }
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html.replace('</head>', `<script type="module" src="/assets/generation-${deployment}.js"></script></head>`)); return; }
    const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.json') || path.endsWith('.webmanifest') ? 'application/json' : path.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    response.setHeader('Content-Type', type); response.end(await readFile(`${assetRoot}${path.slice(1)}`));
  } catch { response.statusCode = 404; response.end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
let page = await context.newPage();
try {
  await page.goto(origin);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller && window.syntheticBuild === 'old');
  await page.getByRole('button', { name: '記録を追加', exact: true }).click();
  await page.getByRole('button', { name: '支出を手入力', exact: true }).click();
  await page.locator('#manual-transaction-payee').fill('Synthetic update draft');
  await page.locator('#manual-transaction-amount').fill('4321');
  await page.getByText('入力内容を端末に保存しました。', { exact: true }).waitFor();
  const profile = await page.evaluate(() => localStorage.getItem('kakeimatch.local-profile.v1'));
  const other = await context.newPage(); await other.goto(origin);
  await other.waitForFunction(() => window.syntheticBuild === 'old');
  deployment = 'new'; failNew = true;
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    const failed = new Promise(resolve => registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker.addEventListener('statechange', () => { if (worker.state === 'redundant') resolve(); });
    }, { once: true }));
    await registration.update(); await failed;
  });
  assert.equal(await page.evaluate(() => navigator.serviceWorker.getRegistration().then(registration => registration.waiting)), null);
  assert.equal(await page.evaluate(() => window.syntheticBuild), 'old');
  failNew = false;
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
  await page.locator('#app-update-notice').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#manual-transaction-payee').inputValue(), 'Synthetic update draft');
  assert.equal(await page.locator('#manual-transaction-amount').inputValue(), '4321');
  if (process.env.PWA_UPDATE_SCREENSHOT_PATH) await page.screenshot({ path: process.env.PWA_UPDATE_SCREENSHOT_PATH });
  await other.reload();
  assert.equal(await other.evaluate(() => window.syntheticBuild), 'old', 'reloading one old tab must not receive new HTML');
  assert.deepEqual((await page.evaluate(() => caches.keys())).filter(name => name.startsWith('kakeimatch-shell-')).sort(), ['kakeimatch-shell-new', 'kakeimatch-shell-old']);
  await context.setOffline(true);
  await other.reload();
  assert.equal(await other.evaluate(() => window.syntheticBuild), 'old');
  await context.setOffline(false);
  await other.close(); await page.close();
  // With all controlled clients gone, the waiting worker naturally activates.
  await new Promise(resolve => setTimeout(resolve, 250));
  page = await context.newPage(); await page.goto(origin);
  await page.waitForFunction(() => window.syntheticBuild === 'new');
  assert.equal(await page.evaluate(() => localStorage.getItem('kakeimatch.local-profile.v1')), profile);
  assert.deepEqual((await page.evaluate(() => caches.keys())).filter(name => name.startsWith('kakeimatch-shell-')), ['kakeimatch-shell-new']);
  await page.getByRole('button', { name: '記録を追加', exact: true }).click();
  await page.getByRole('button', { name: '支出を手入力', exact: true }).click();
  assert.equal(await page.locator('#manual-transaction-payee').inputValue(), 'Synthetic update draft');
  assert.equal(await page.locator('#manual-transaction-amount').inputValue(), '4321');
  await context.setOffline(true); await page.reload();
  await page.waitForFunction(() => window.syntheticBuild === 'new');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log('PASS: failed install retry, waiting update preserves draft/two old tabs, same-generation online/offline reload, natural activation, old cache cleanup and retained profile/draft after reopening.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
