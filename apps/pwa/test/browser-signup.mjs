import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

if (!process.env.PWA_E2E_URL) throw new Error('Set PWA_E2E_URL to an isolated synthetic preview.');
// WebAuthn rejects IP-address RP IDs, so use the loopback host name for the virtual Passkey.
const base = new URL(process.env.PWA_E2E_URL);
if (base.hostname === '127.0.0.1') base.hostname = 'localhost';
const browser = await chromium.launch({ headless: true, ...(process.env.PWA_BROWSER_PATH ? { executablePath: process.env.PWA_BROWSER_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
await context.addInitScript(() => { navigator.serviceWorker.register = async () => ({}); });

const familyToken = 'F'.repeat(43);
const requests = [];
let signedIn = false;
let plan = 'free';
let signupError = null;

// The real bot check is replaced by a synthetic widget; the server-side check is covered by Worker tests.
await context.route('https://challenges.cloudflare.com/**', route => route.fulfill({
  contentType: 'application/javascript',
  headers: { 'cross-origin-resource-policy': 'cross-origin' },
  body: `window.turnstile = {
    render(container, options) { this.options = options; const note = document.createElement('p'); note.textContent = '確認済み'; container.append(note); this.reset(); return 'synthetic-widget'; },
    reset() { setTimeout(() => this.options.callback('synthetic-bot-check-token'), 0); }, remove() {},
  };`,
}));
await context.route('**/api/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  const body = request.postData() ? JSON.parse(request.postData()) : null;
  requests.push({ path: url.pathname, body });
  if (url.pathname === '/api/account/signup-config') return route.fulfill({ json: { signupAvailable: true, turnstileSiteKey: 'synthetic-site-key' } });
  if (url.pathname === '/api/account/signup') {
    if (signupError) return route.fulfill({ status: 409, json: { error: signupError } });
    return route.fulfill({ status: 201, json: { context: 'S'.repeat(43), expiresAt: '2099-01-01T00:00:00Z' } });
  }
  if (url.pathname === '/api/auth/passkey/generate-register-options') {
    return route.fulfill({ json: {
      challenge: Buffer.from('synthetic-registration-challenge').toString('base64url'),
      rp: { name: 'KakeiMatch', id: base.hostname },
      user: { id: Buffer.from('synthetic-new-user').toString('base64url'), name: 'Synthetic Member', displayName: 'Synthetic Member' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      timeout: 60000, attestation: 'none',
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    } });
  }
  if (url.pathname === '/api/auth/passkey/verify-registration') {
    signedIn = true;
    return route.fulfill({ json: { id: 'synthetic-passkey', user: { id: 'synthetic-new-user', name: 'Synthetic Member' }, session: { id: 'synthetic-session' } } });
  }
  if (url.pathname === '/api/auth/get-session') {
    return route.fulfill({ json: signedIn ? { user: { id: 'synthetic-new-user', name: 'Synthetic Member' }, session: { id: 'synthetic-session', expiresAt: '2099-01-01T00:00:00Z' } } : null });
  }
  if (url.pathname === '/api/ai/usage') {
    return route.fulfill({ json: plan === 'family' ? { plan, used: 0, limit: null, remaining: null } : { plan, used: 0, limit: 30, remaining: 30 } });
  }
  if (url.pathname === '/api/ai/token') return route.fulfill({ json: { token: 'synthetic.jwt.value', expiresAt: 4102444800 } });
  if (url.pathname === '/api/account/family-invites/accept') {
    if (!signedIn) return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
    plan = 'family';
    return route.fulfill({ json: { plan: 'family' } });
  }
  if (url.pathname.includes('passkey') && url.pathname.includes('list')) return route.fulfill({ json: [] });
  return route.fulfill({ json: {} });
});

const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const click = name => page.getByRole('button', { name, exact: true }).click();
try {
  await page.goto(`${base.origin}/#family-invite=${familyToken}`);
  await page.getByText('家族プランの招待', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '', 'the invite token is removed from the address bar');
  assert.equal(await page.evaluate(() => history.length > 0 && location.href.includes('family-invite')), false);
  await page.getByText('招待を受け取るには、Passkeyでログインするか、新規登録してください。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '招待コードで登録', exact: true }).isVisible(), false, 'recovery registration is shown only for recovery links');

  await click('新規登録');
  await page.getByLabel('表示名', { exact: true }).fill('Synthetic Member');
  await page.getByLabel('メールアドレス', { exact: true }).fill('member@example.test');
  const submit = page.getByRole('button', { name: 'Passkeyを作成して登録', exact: true });
  await page.waitForFunction(() => !document.querySelector('#signup-submit')?.disabled);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `signup form does not overflow a 375px screen (${overflow}px)`);

  signupError = 'email_unavailable';
  await submit.click();
  await page.getByText('このメールアドレスは登録できません。登録済みの場合は「Passkeyで続ける」からログインしてください。', { exact: true }).waitFor();
  signupError = null;
  await page.waitForFunction(() => !document.querySelector('#signup-submit')?.disabled);
  await submit.click();
  await page.getByText('AI利用の認証を確認しました。', { exact: true }).waitFor({ timeout: 20000 });
  await page.getByText('今月の読み取り 0 / 30回 · Free', { exact: true }).waitFor();

  const signup = requests.filter(entry => entry.path === '/api/account/signup').at(-1);
  assert.deepEqual(Object.keys(signup.body).sort(), ['email', 'name', 'turnstileToken']);
  assert.equal(signup.body.turnstileToken, 'synthetic-bot-check-token');

  await click('家族プランを受け取る');
  await page.getByText('家族プランになりました。', { exact: true }).waitFor();
  await page.getByText('今月の読み取り 0回 · Family · 上限なし', { exact: true }).waitFor();
  const accept = requests.find(entry => entry.path === '/api/account/family-invites/accept');
  assert.deepEqual(accept.body, { token: familyToken }, 'only the token is sent; the server derives the user');
  assert.equal(await page.locator('#family-invite').isVisible(), false);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('kakeimatch.familyInvite')), null);
  assert.deepEqual(errors, []);
  console.log('PASS: open signup with bot check and virtual Passkey, Free start, Family invite from URL fragment. Synthetic APIs only.');
} finally {
  await browser.close();
}
