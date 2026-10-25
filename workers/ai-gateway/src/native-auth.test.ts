import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from './test-support/sqlite-d1';
import type { NativeEnv } from './native-auth';
import { handleRequest as handleWebRequest } from './worker';
import { reserveFlow, dayKey, type FlowLimits } from './receipt-ai-usage';
import { addressDayMac } from './guest-ai';

const attest = vi.fn(async ({ attestation }: { attestation: string }) => {
  if (attestation === 'bad') throw new Error('synthetic_invalid_attestation');
  return { publicKey: 'synthetic-public-key', receipt: 'synthetic-receipt' };
});
const assertion = vi.fn(async ({ counter }: { counter: number }) => ({ counter: counter + 1 }));
vi.mock('./app-attest', () => ({ verifyAttestation: attest, verifyAssertion: assertion }));

const origin = 'https://native.example.test';
const teamId = 'ABCDE12345';
const appId = `${teamId}.jp.kakeimatch.ios`;
const now = 1_800_000_000;
const keyId = Buffer.alloc(32, 7).toString('base64');
const secret = 'synthetic-native-test-secret-with-enough-length';
let sqlite: DatabaseSync;
let env: NativeEnv;
let handleNativeRequest: typeof import('./native-auth').handleNativeRequest;

beforeEach(async () => {
  vi.clearAllMocks();
  sqlite?.close();
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  const { handleNativeRequest: handle } = await import('./native-auth');
  handleNativeRequest = handle;
  env = {
    ACCOUNT_DB: sqliteD1(sqlite), BETTER_AUTH_SECRET: secret, AI_GATEWAY_AUTH_SECRET: secret,
    AI_USER_RATE_LIMIT: { limit: async () => ({ success: true }) }, CLOUD_ACCOUNT_ORIGIN: origin,
    NATIVE_APP_TEAM_ID: teamId, NATIVE_APP_ID: appId, NATIVE_APP_ORIGIN: origin, NATIVE_APP_RP_ID: 'native.example.test',
    NATIVE_APP_ATTEST_ENVIRONMENT: 'development',
  };
});

function request(path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') {
  return new Request(`${origin}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
const run = (path: string, body?: unknown, headers?: Record<string, string>, method?: string) => handleNativeRequest(request(path, body, headers, method), env, { nowSeconds: () => now });
const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
async function issueChallenge(purpose: 'attest' | 'guest' | 'token' = 'attest', id = keyId, headers?: Record<string, string>) {
  return run('/api/native/challenge', { purpose, keyId: id }, headers);
}
async function registerKey(id = keyId) {
  const challengeResponse = await issueChallenge('attest', id);
  const challenge = await challengeResponse.json() as { challengeId: string };
  const response = await run('/api/native/attest', { challengeId: challenge.challengeId, keyId: id, attestation: 'synthetic-proof' });
  expect(response.status).toBe(200);
}
async function guestLogin(id = keyId) {
  const challengeResponse = await issueChallenge('guest', id);
  const challenge = await challengeResponse.json() as { challengeId: string };
  return run('/api/native/guest', { challengeId: challenge.challengeId, keyId: id, assertion: 'synthetic-assertion' });
}

describe('native authentication HTTP boundary and D1 effects', () => {
  it('rejects origin/cookie-bearing native calls and unavailable or mismatched configuration', async () => {
    expect((await run('/api/native/config', undefined, { origin })).status).toBe(403);
    expect((await run('/api/native/config', undefined, { cookie: 'session=ambient' })).status).toBe(403);
    expect((await run('/api/native/challenge', { purpose: 'attest', keyId }, { origin })).status).toBe(403);
    env.NATIVE_APP_ID = undefined;
    expect((await run('/api/native/config')).status).toBe(200);
    expect(await (await run('/api/native/config')).json()).toMatchObject({ available: false, rpId: null });
    expect((await run('/api/native/challenge', { purpose: 'attest', keyId })).status).toBe(503);
    env.NATIVE_APP_ID = appId;
    env.NATIVE_APP_RP_ID = 'wrong.example.test';
    expect((await run('/api/native/config')).status).toBe(200);
    expect(await (await run('/api/native/config')).json()).toMatchObject({ available: false });
  });

  it('serves AASA directly through the PWA Worker with HTTPS, no redirects, and no guessed identity', async () => {
    const { default: appWorker } = await import('../../../apps/pwa/src/worker');
    const assetFetch = vi.fn(async () => new Response('unexpected SPA asset'));
    const appEnv = { ...env, ACCOUNT_DB: env.ACCOUNT_DB!, ASSETS: { fetch: assetFetch } };
    const response = await appWorker.fetch(request('/.well-known/apple-app-site-association'), appEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ webcredentials: { apps: [appId] } });
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('content-security-policy')).toBeTruthy();
    expect(assetFetch).not.toHaveBeenCalled();
    for (const setting of ['NATIVE_APP_TEAM_ID', 'NATIVE_APP_ID', 'NATIVE_APP_ORIGIN', 'NATIVE_APP_RP_ID', 'NATIVE_APP_ATTEST_ENVIRONMENT'] as const) {
      expect((await appWorker.fetch(request('/.well-known/apple-app-site-association'), { ...appEnv, [setting]: undefined })).status).toBe(404);
    }
    const http = new Request('http://native.example.test/.well-known/apple-app-site-association');
    expect((await appWorker.fetch(http, appEnv)).status).toBe(404);
    const nativeConfig = await appWorker.fetch(request('/api/native/config'), appEnv);
    expect(await nativeConfig.json()).toEqual({ available: true, rpId: 'native.example.test', appAttestEnvironment: 'development' });
  });

  it('validates JSON, exact request fields, body size and route allowlist', async () => {
    expect((await handleNativeRequest(new Request(`${origin}/api/native/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }), env, { nowSeconds: () => now })).status).toBe(400);
    expect((await run('/api/native/challenge', { purpose: 'attest', keyId, userId: 'attacker' })).status).toBe(400);
    expect((await run('/api/native/challenge', { purpose: 'attest', keyId, padding: 'x'.repeat(70_000) })).status).toBe(400);
    for (const path of ['/api/native/admin', '/api/native/account/invites', '/api/native/account/recovery', '/api/native/auth/sign-in']) {
      const response = await run(path, {});
      expect(response.status).toBe(404);
    }
    expect(count('native_challenges')).toBe(0);
  });

  it('issues one-use challenges for 120 seconds, consumes failed proofs, and rejects expiry/replay/purpose/key mismatch', async () => {
    const issued = await issueChallenge();
    expect(issued.status).toBe(200);
    const challenge = await issued.json() as { challengeId: string; challenge: string; expiresAt: number };
    expect(challenge.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge.expiresAt).toBe(now + 120);
    expect((await run('/api/native/attest', { challengeId: challenge.challengeId, keyId, attestation: 'bad' })).status).toBe(403);
    expect((await run('/api/native/attest', { challengeId: challenge.challengeId, keyId, attestation: 'bad' })).status).toBe(403);

    const expiredResponse = await issueChallenge();
    const expired = await expiredResponse.json() as { challengeId: string };
    expect((await handleNativeRequest(request('/api/native/attest', { challengeId: expired.challengeId, keyId, attestation: 'proof' }), env, { nowSeconds: () => now + 120 })).status).toBe(403);
    const wrongPurpose = await issueChallenge('guest');
    const wrong = await wrongPurpose.json() as { challengeId: string };
    expect((await run('/api/native/attest', { challengeId: wrong.challengeId, keyId, attestation: 'proof' })).status).toBe(403);
    expect(attest).toHaveBeenCalledOnce();
  });

  it('binds a key to a guest once, stores opaque 14-day sessions, and reuses the same user on new assertions', async () => {
    await registerKey();
    const first = await guestLogin();
    expect(first.status).toBe(201);
    const firstSession = await first.json() as { sessionToken: string; expiresAt: number };
    expect(firstSession.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(firstSession.expiresAt).toBe(now + 14 * 86400);
    const firstUser = sqlite.prepare('SELECT guest_user_id FROM native_app_keys WHERE key_id=?').get(keyId) as { guest_user_id: string };
    expect(count('user')).toBe(1);
    expect(count('guest_devices')).toBe(1);
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM native_sessions').all())).not.toContain(firstSession.sessionToken);
    const tokenChallenge = await issueChallenge('guest');
    const challenge = await tokenChallenge.json() as { challengeId: string };
    const second = await run('/api/native/guest', { challengeId: challenge.challengeId, keyId, assertion: 'next-assertion' });
    expect(second.status).toBe(201);
    expect((await second.json() as { sessionToken: string }).sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sqlite.prepare('SELECT guest_user_id FROM native_app_keys WHERE key_id=?').get(keyId)).toEqual(firstUser);
    expect(count('user')).toBe(1);
    expect(count('guest_devices')).toBe(1);
    expect(count('native_sessions')).toBe(2);
    expect(sqlite.prepare('SELECT DISTINCT user_id FROM native_sessions').all()).toEqual([{ user_id: firstUser.guest_user_id }]);
    expect(sqlite.prepare('SELECT counter FROM native_app_keys WHERE key_id=?').get(keyId)).toEqual({ counter: 2 });
  });

  it('shares the daily address guest-creation ceiling with the Web guest flow', async () => {
    const { addressDayMac, GUEST_CREATIONS_PER_ADDRESS_DAILY } = await import('./guest-ai');
    const addressRequest = request('/api/native/challenge', { purpose: 'attest', keyId }, { 'cf-connecting-ip': '192.0.2.44' });
    const address = await addressDayMac(secret, addressRequest, now);
    await registerKey();
    // Existing Web-created guest devices count against the same guest_devices address/day bucket.
    for (let index = 0; index < GUEST_CREATIONS_PER_ADDRESS_DAILY; index++) {
      const userId = `web-guest-${index}`;
      await env.ACCOUNT_DB!.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,\'Guest\',?,0,?,?)').bind(userId, `${userId}@guest.kakeimatch.invalid`, now * 1000, now * 1000).run();
      await env.ACCOUNT_DB!.prepare('INSERT INTO guest_devices(user_id,secret_hash,created_at,created_day,created_ip_day_mac,last_used_at) VALUES (?,?,?,?,?,?)').bind(userId, `hash-${index}`, now, '2027-01-15', address, now).run();
    }
    const challengeResponse = await issueChallenge('guest', keyId, { 'cf-connecting-ip': '192.0.2.44' });
    const challenge = await challengeResponse.json() as { challengeId: string };
    const login = await run('/api/native/guest', { challengeId: challenge.challengeId, keyId, assertion: 'proof' }, { 'cf-connecting-ip': '192.0.2.44' });
    expect(login.status).toBe(429);
    expect(await login.json()).toEqual({ error: 'guest_limit_reached' });
    expect(count('guest_devices')).toBe(GUEST_CREATIONS_PER_ADDRESS_DAILY);
  });

  it('checks revoked keys and increments the App Attest counter with compare-and-swap semantics', async () => {
    await registerKey();
    const challenge = await issueChallenge('guest');
    const payload = await challenge.json() as { challengeId: string };
    sqlite.prepare('UPDATE native_app_keys SET revoked_at=? WHERE key_id=?').run(now, keyId);
    expect((await run('/api/native/guest', { challengeId: payload.challengeId, keyId, assertion: 'proof' })).status).toBe(403);
    expect(assertion).not.toHaveBeenCalled();
  });

  it('allows only one concurrent assertion to advance the same key counter', async () => {
    await registerKey();
    const firstChallengeResponse = await issueChallenge('guest');
    const secondChallengeResponse = await issueChallenge('guest');
    const firstChallenge = await firstChallengeResponse.json() as { challengeId: string };
    const secondChallenge = await secondChallengeResponse.json() as { challengeId: string };
    const results = await Promise.all([
      run('/api/native/guest', { challengeId: firstChallenge.challengeId, keyId, assertion: 'parallel-one' }),
      run('/api/native/guest', { challengeId: secondChallenge.challengeId, keyId, assertion: 'parallel-two' }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([201, 403]);
    expect(sqlite.prepare('SELECT counter FROM native_app_keys WHERE key_id=?').get(keyId)).toEqual({ counter: 1 });
    expect(count('user')).toBe(1);
    expect(count('native_sessions')).toBe(1);
  });

  it('issues audience-separated short AI access tokens and refuses Web JWTs or tokens as account sessions', async () => {
    await registerKey();
    const login = await guestLogin();
    const session = await login.json() as { sessionToken: string };
    const challengeResponse = await issueChallenge('token', keyId, { authorization: `Native ${session.sessionToken}` });
    expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json() as { challengeId: string };
    const issued = await run('/api/native/ai/token', { challengeId: challenge.challengeId, keyId, assertion: 'token-assertion' }, { authorization: `Native ${session.sessionToken}` });
    expect(issued.status).toBe(200);
    const access = await issued.json() as { token: string; expiresAt: number };
    expect(access.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(access.expiresAt).toBe(now + 600);
    expect((await run('/api/native/auth/get-session', undefined, { authorization: `Native ${access.token}` })).status).toBe(401);
    const { issueAiToken } = await import('./worker');
    const webToken = await issueAiToken('synthetic-web-user', secret, now);
    expect((await run('/api/native/ai/gemini', {}, { authorization: `Bearer ${webToken}` })).status).toBe(401);
    const row = sqlite.prepare('SELECT audience FROM native_ai_tokens').get() as { audience: string };
    expect(row.audience).toBe('kakeimatch-native-ai');

    env.AI_EMERGENCY_STOP = 'true';
    env.GEMINI_API_KEY = 'synthetic-gemini-key';
    const stopped = await run('/api/native/ai/gemini', {
      contentType: 'image/png',
      imageBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString('base64'),
      flowId: crypto.randomUUID(),
    }, { authorization: `Bearer ${access.token}` });
    expect(stopped.status).toBe(503);
    expect(await stopped.json()).toEqual({ error: 'ai_temporarily_paused' });
  });

  it('keeps all Web POST Origin checks and prevents native credentials from becoming Web credentials', async () => {
    for (const path of ['/api/ai/guest', '/api/ai/token', '/api/ai/gemini', '/api/ai/payroll', '/api/ai/jev', '/api/contact']) {
      for (const headers of [{}, { origin: 'https://evil.example.test' }] as Record<string, string>[]) {
        const response = await handleWebRequest(request(path, {}, headers), env, { nowSeconds: () => now });
        expect(response.status, path).toBe(403);
        expect(await response.json()).toEqual({ error: 'forbidden_origin' });
      }
    }
    await registerKey();
    const session = await (await guestLogin()).json() as { sessionToken: string };
    const response = await handleWebRequest(request('/api/ai/gemini', {}, { origin, authorization: `Bearer ${session.sessionToken}` }), env, { nowSeconds: () => now });
    expect(response.status).toBe(401);
  });

  it('rejects wrong challenge purposes, mismatched keys, invalid assertions and expired sessions/tokens', async () => {
    await registerKey();
    const guestChallenge = await (await issueChallenge('guest')).json() as { challengeId: string };
    expect((await run('/api/native/attest', { challengeId: guestChallenge.challengeId, keyId, attestation: 'proof' })).status).toBe(403);
    const secondKey = Buffer.alloc(32, 11).toString('base64');
    expect((await run('/api/native/guest', { challengeId: guestChallenge.challengeId, keyId: secondKey, assertion: 'proof' })).status).toBe(403);
    const bad = await (await issueChallenge('guest')).json() as { challengeId: string };
    assertion.mockRejectedValueOnce(new Error('bad_signature'));
    expect((await run('/api/native/guest', { challengeId: bad.challengeId, keyId, assertion: 'bad' })).status).toBe(403);
    expect(count('user')).toBe(0);
    const session = await (await guestLogin()).json() as { sessionToken: string; expiresAt: number };
    const headers = { authorization: `Native ${session.sessionToken}` };
    const tokenChallenge = await (await issueChallenge('token', keyId, headers)).json() as { challengeId: string };
    const token = await (await run('/api/native/ai/token', { challengeId: tokenChallenge.challengeId, keyId, assertion: 'proof' }, headers)).json() as { token: string; expiresAt: number };
    expect((await handleNativeRequest(request('/api/native/ai/gemini', {}, { authorization: `Bearer ${token.token}` }), env, { nowSeconds: () => token.expiresAt })).status).toBe(401);
    expect((await handleNativeRequest(request('/api/native/ai/usage', undefined, headers), env, { nowSeconds: () => session.expiresAt })).status).toBe(401);
    env.NATIVE_APP_ATTEST_ENVIRONMENT = 'production';
    expect((await run('/api/native/ai/usage', undefined, headers)).status).toBe(401);
    env.NATIVE_APP_ATTEST_ENVIRONMENT = 'development';
    env.NATIVE_APP_ID = 'FGHIJ67890.jp.kakeimatch.ios';
    expect((await run('/api/native/ai/usage', undefined, headers)).status).toBe(401);
  });

  it('retains guest daily-five and address-twenty quotas through the actual native AI dispatch path', async () => {
    await registerKey();
    const session = await (await guestLogin()).json() as { sessionToken: string };
    const user = (sqlite.prepare('SELECT guest_user_id FROM native_app_keys').get() as { guest_user_id: string }).guest_user_id;
    const limits: FlowLimits = { monthlyDefault: 30, guestDaily: 5, guestAddressDaily: 20, contactSubmitAddressDaily: 10 };
    const address = await addressDayMac(secret, request('/api/native/ai/gemini'), now);
    for (let index = 0; index < 5; index++) expect(await reserveFlow(env.ACCOUNT_DB!, user, crypto.randomUUID(), 'mac', now, limits, 'receipt', address)).toBe('reserved');
    sqlite.exec('UPDATE ai_receipt_flows SET dispatched=1');
    const native = { authorization: `Native ${session.sessionToken}` };
    const usage = await run('/api/native/ai/usage', undefined, native);
    expect(await usage.json()).toEqual({ plan: 'guest', period: 'day', day: dayKey(now), used: 5, limit: 5, remaining: 0 });
    const tokenChallenge = await (await issueChallenge('token', keyId, native)).json() as { challengeId: string };
    const access = await (await run('/api/native/ai/token', { challengeId: tokenChallenge.challengeId, keyId, assertion: 'proof' }, native)).json() as { token: string };
    env.GEMINI_API_KEY = 'synthetic-provider-key';
    const provider = vi.fn<typeof fetch>();
    const receipt = () => request('/api/native/ai/gemini', {
      flowId: crypto.randomUUID(), contentType: 'image/png', imageBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString('base64'),
    }, { authorization: `Bearer ${access.token}` });
    const rejected = await handleNativeRequest(receipt(), env, { nowSeconds: () => now, fetchImpl: provider });
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toEqual({ error: 'ai_quota_exceeded' });
    // Same guest can have no own quota usage and still be stopped by other guests on this address.
    sqlite.prepare('DELETE FROM ai_receipt_flows').run();
    for (let guest = 0; guest < 4; guest++) {
      const other = `address-guest-${guest}`;
      sqlite.prepare('INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES (?,?,?,1,1)').run(other, 'Synthetic', `${other}@example.invalid`);
      sqlite.prepare('INSERT INTO guest_devices(user_id,secret_hash,created_at,created_day,created_ip_day_mac,last_used_at) VALUES (?,?,?,?,?,?)').run(other, `address-hash-${guest}`, now, dayKey(now), address, now);
      for (let index = 0; index < 5; index++) expect(await reserveFlow(env.ACCOUNT_DB!, other, crypto.randomUUID(), 'mac', now, limits, 'receipt', address)).toBe('reserved');
    }
    sqlite.exec('UPDATE ai_receipt_flows SET dispatched=1');
    const addressRejected = await handleNativeRequest(receipt(), env, { nowSeconds: () => now, fetchImpl: provider });
    expect(addressRejected.status).toBe(429);
    expect(await addressRejected.json()).toEqual({ error: 'ai_quota_exceeded' });
    expect(provider).not.toHaveBeenCalled();
    expect((await run('/api/native/ai/costs', undefined, native)).status).toBe(401);
    expect((await run('/api/native/contact', {}, { authorization: `Bearer ${access.token}` })).status).toBe(401);
  });

  it('invalidates native sessions and AI tokens through key, session, and user deletion cascades', async () => {
    await registerKey();
    const login = await guestLogin();
    const session = await login.json() as { sessionToken: string };
    const nativeSession = sqlite.prepare('SELECT token_hash FROM native_sessions').get() as { token_hash: string };
    const tokenHash = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(session.sessionToken))).toString('base64url');
    await env.ACCOUNT_DB!.prepare("INSERT INTO native_ai_tokens(token_hash,session_hash,audience,created_at,expires_at) VALUES (?,?,'kakeimatch-native-ai',?,?)").bind(tokenHash, nativeSession.token_hash, now, now + 600).run();
    sqlite.prepare('DELETE FROM user WHERE id=(SELECT user_id FROM native_sessions WHERE token_hash=?)').run(nativeSession.token_hash);
    expect(count('native_sessions')).toBe(0);
    expect(count('native_ai_tokens')).toBe(0);
    expect(sqlite.prepare('SELECT guest_user_id FROM native_app_keys WHERE key_id=?').get(keyId)).toEqual({ guest_user_id: null });
    expect((await run('/api/native/auth/get-session', undefined, { authorization: `Native ${session.sessionToken}` })).status).toBe(401);
  });
});
