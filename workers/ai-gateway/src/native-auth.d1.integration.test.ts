import 'reflect-metadata';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayKey, reserveCategorySuggestionFlow, reserveFlow } from './receipt-ai-usage';

// App Attest cryptography is covered separately; this suite exercises real Better Auth/D1 wiring.
vi.mock('./app-attest', () => ({
  verifyAttestation: vi.fn(async () => ({ publicKey: 'synthetic-public-key', receipt: 'synthetic-receipt' })),
  verifyAssertion: vi.fn(async ({ counter }: { counter: number }) => ({ counter: counter + 1 })),
}));

const origin = 'https://native-d1.example.test';
const teamId = 'ABCDE12345';
const appId = `${teamId}.jp.kakeimatch.ios`;
const keyId = Buffer.alloc(32, 9).toString('base64');
const secret = 'synthetic-native-d1-integration-secret';
const migrations = readdirSync(new URL('../migrations/', import.meta.url))
  .filter(name => name.endsWith('.sql'))
  .sort()
  .map(name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
const migrationSql = migrations.map(sql => sql.replace(/^--.*$/gm, '').replace(/\s+/g, ' ').trim()).join('\n');
const instances: Miniflare[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map(instance => instance.dispose())); });

async function makeFixture(nowSeconds = Math.floor(Date.now() / 1000)) {
  const miniflare = new Miniflare({
    script: "export default { fetch() { return new Response('ok'); } }",
    modules: true,
    compatibilityDate: '2026-08-01',
    d1Databases: { ACCOUNT_DB: 'native-auth-synthetic-test' },
  });
  instances.push(miniflare);
  const db = await miniflare.getD1Database('ACCOUNT_DB');
  await db.exec(migrationSql);
  await db.prepare('INSERT INTO native_app_keys(key_id,origin,app_id,environment,public_key,receipt,created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(keyId, origin, appId, 'development', 'synthetic-public-key', 'synthetic-receipt', nowSeconds).run();
  const env = {
    ACCOUNT_DB: db,
    AI_GATEWAY_AUTH_SECRET: secret,
    AI_USER_RATE_LIMIT: { limit: async () => ({ success: true }) },
    CLOUD_ACCOUNT_ORIGIN: origin,
    NATIVE_APP_TEAM_ID: teamId,
    NATIVE_APP_ID: appId,
    NATIVE_APP_ORIGIN: origin,
    NATIVE_APP_RP_ID: 'native-d1.example.test',
    NATIVE_APP_ATTEST_ENVIRONMENT: 'development',
  };
  const run = (path: string, body?: unknown, authorization?: string, method = body === undefined ? 'GET' : 'POST', at = nowSeconds) =>
    import('./native-auth').then(({ handleNativeRequest }) => handleNativeRequest(new Request(`${origin}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(authorization ? { authorization } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env, { nowSeconds: () => at }));
  return { db, env, nowSeconds, run };
}
type Fixture = Awaited<ReturnType<typeof makeFixture>>;
const contractFixtures = new URL('../../../apps/ios/KakeiMatchTests/Fixtures/native-contract/', import.meta.url);
function expectContractKeys(value: Record<string, unknown>, keys: string[]) {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}
function writeContractFixture(name: string, value: unknown) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const path = new URL(`${name}.json`, contractFixtures);
  if (process.env.UPDATE_NATIVE_CONTRACT_FIXTURES === '1') {
    mkdirSync(contractFixtures, { recursive: true });
    writeFileSync(path, serialized);
  }
  expect(readFileSync(path, 'utf8'), `${name}.json is stale. Run npm run test:update-native-contract-fixtures --prefix workers/ai-gateway`).toBe(serialized);
}
async function guestSignIn(run: Fixture['run']) {
  const challenge = await run('/api/native/challenge', { purpose: 'guest', keyId });
  expect(challenge.status).toBe(200);
  const { challengeId } = await challenge.json() as { challengeId: string };
  const response = await run('/api/native/guest', { challengeId, keyId, assertion: 'synthetic-app-attest-guest-assertion' });
  expect(response.status).toBe(201);
  return await response.json() as { sessionToken: string };
}
async function aiTokenFor(run: Fixture['run'], sessionToken: string) {
  const authorization = `Native ${sessionToken}`;
  const challenge = await (await run('/api/native/challenge', { purpose: 'token', keyId }, authorization)).json() as { challengeId: string };
  const response = await run('/api/native/ai/token', { challengeId: challenge.challengeId, keyId, assertion: 'synthetic-app-attest-token-assertion' }, authorization);
  expect(response.status).toBe(200);
  return (await response.json() as { token: string }).token;
}
const fixedNow = 1_800_000_000;
describe('native auth on local D1', () => {
  it('serves config, guest sign-in, and AI tokens', async () => {
    const { run } = await makeFixture(fixedNow);
    expect(await (await run('/api/native/config')).json()).toMatchObject({ available: true, rpId: 'native-d1.example.test' });
    const session = await guestSignIn(run);
    expect(await aiTokenFor(run, session.sessionToken)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('counts a key bound to an account against its entitlement, and only the daily cap without one', async () => {
    const { db, run } = await makeFixture(fixedNow);
    const limits = { guestDaily: 5, guestAddressDaily: 20, contactSubmitAddressDaily: 10 };
    await db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
      .bind('synthetic-account', 'Synthetic Member', 'member@example.invalid', 1, fixedNow * 1000, fixedNow * 1000).run();
    await db.prepare('UPDATE native_app_keys SET account_user_id=? WHERE key_id=?').bind('synthetic-account', keyId).run();
    const session = await guestSignIn(run);
    // The bound key signs in as the account itself; no guest row is created for it.
    expect(await db.prepare('SELECT user_id, identity FROM native_sessions').first()).toEqual({ user_id: 'synthetic-account', identity: 'guest' });
    expect(await db.prepare('SELECT guest_user_id FROM native_app_keys WHERE key_id=?').bind(keyId).first()).toEqual({ guest_user_id: null });
    const usage = async () => (await run('/api/native/ai/usage', undefined, `Native ${session.sessionToken}`)).json();
    expect(await usage()).toEqual({ plan: 'free', period: 'day', day: dayKey(fixedNow), used: 0, limit: 5, remaining: 5, supportId: 'synthetic-account' });
    for (let index = 0; index < 5; index++) expect(await reserveFlow(db, 'synthetic-account', crypto.randomUUID(), `mac-${index}`, fixedNow, limits, 'receipt', 'address')).toBe('reserved');
    await db.prepare('UPDATE ai_receipt_flows SET dispatched=1').run();
    expect(await usage()).toMatchObject({ used: 5, remaining: 0 });
    expect(await reserveFlow(db, 'synthetic-account', crypto.randomUUID(), 'mac-5', fixedNow, limits, 'receipt', 'address')).toBe('ai_quota_exceeded');
    // An explicit entitlement replaces the daily cap with its monthly limit.
    await db.prepare("INSERT INTO account_entitlements(user_id,plan,monthly_ai_limit,updated_at) VALUES ('synthetic-account','pro',10,?)").bind(fixedNow).run();
    expect(await reserveFlow(db, 'synthetic-account', crypto.randomUUID(), 'mac-6', fixedNow, limits, 'receipt', 'address')).toBe('reserved');
    await db.prepare('UPDATE ai_receipt_flows SET dispatched=1').run();
    expect(await usage()).toMatchObject({ plan: 'pro', period: 'month', used: 6, limit: 10, remaining: 4, supportId: 'synthetic-account' });
  });

  it('keeps the guest daily cap for a key that has no account', async () => {
    const { db, run } = await makeFixture(fixedNow);
    const limits = { guestDaily: 5, guestAddressDaily: 20, contactSubmitAddressDaily: 10 };
    const session = await guestSignIn(run);
    const guest = await db.prepare('SELECT guest_user_id FROM native_app_keys WHERE key_id=?').bind(keyId).first<{ guest_user_id: string }>();
    expect(guest?.guest_user_id).toMatch(/^[0-9a-f-]{36}$/);
    for (let index = 0; index < 5; index++) expect(await reserveFlow(db, guest!.guest_user_id, crypto.randomUUID(), `mac-${index}`, fixedNow, limits, 'receipt', 'address')).toBe('reserved');
    await db.prepare('UPDATE ai_receipt_flows SET dispatched=1').run();
    expect(await (await run('/api/native/ai/usage', undefined, `Native ${session.sessionToken}`)).json())
      .toEqual({ plan: 'guest', period: 'day', day: dayKey(fixedNow), used: 5, limit: 5, remaining: 0, supportId: guest!.guest_user_id });
    expect(await reserveFlow(db, guest!.guest_user_id, crypto.randomUUID(), 'mac-5', fixedNow, limits, 'receipt', 'address')).toBe('ai_quota_exceeded');
    expect(await reserveCategorySuggestionFlow(db, guest!.guest_user_id, crypto.randomUUID(), 'cat-mac-5', fixedNow, limits, 'address')).toBe('ai_quota_exceeded');
  });

  it('applies the monthly entitlement limit to a guest-origin user with an entitlement row', async () => {
    const { db, run } = await makeFixture(fixedNow);
    const limits = { guestDaily: 5, guestAddressDaily: 20, contactSubmitAddressDaily: 10 };
    const session = await guestSignIn(run);
    const guest = await db.prepare('SELECT guest_user_id FROM native_app_keys WHERE key_id=?').bind(keyId).first<{ guest_user_id: string }>();
    const guestUserId = guest!.guest_user_id;
    expect(await db.prepare('SELECT 1 AS found FROM guest_devices WHERE user_id=?').bind(guestUserId).first()).toEqual({ found: 1 });
    await db.prepare("INSERT INTO account_entitlements(user_id,plan,monthly_ai_limit,updated_at) VALUES (?,'pro',7,?)").bind(guestUserId, fixedNow).run();
    for (let index = 0; index < 6; index++) {
      expect(await reserveFlow(db, guestUserId, crypto.randomUUID(), `mac-${index}`, fixedNow, limits, 'receipt', 'address')).toBe('reserved');
    }
    expect(await reserveCategorySuggestionFlow(db, guestUserId, crypto.randomUUID(), 'cat-mac-6', fixedNow, limits, 'address')).toBe('reserved');
    expect(await reserveFlow(db, guestUserId, crypto.randomUUID(), 'mac-7', fixedNow, limits, 'receipt', 'address')).toBe('ai_quota_exceeded');
    expect(await reserveCategorySuggestionFlow(db, guestUserId, crypto.randomUUID(), 'cat-mac-7', fixedNow, limits, 'address')).toBe('ai_quota_exceeded');
    await db.prepare('UPDATE ai_receipt_flows SET dispatched=1').run();
    await db.prepare('UPDATE ai_category_suggestion_flows SET dispatched=1').run();
    expect(await (await run('/api/native/ai/usage', undefined, `Native ${session.sessionToken}`)).json())
      .toMatchObject({ plan: 'pro', period: 'month', used: 7, limit: 7, remaining: 0, supportId: guestUserId });
  });

  it('keeps the AI usage response compatible with the committed iOS fixture', async () => {
    const { db, run } = await makeFixture();
    const { sessionToken } = await guestSignIn(run);
    const authorization = `Native ${sessionToken}`;
    const userId = (await db.prepare('SELECT user_id FROM native_sessions').first<{ user_id: string }>())!.user_id;
    await db.prepare("INSERT INTO account_entitlements(user_id,plan,monthly_ai_limit) VALUES (?,'family',NULL)").bind(userId).run();
    const usageResponse = await run('/api/native/ai/usage', undefined, authorization);
    expect(usageResponse.status).toBe(200);
    const usage = await usageResponse.json() as Record<string, unknown>;
    expectContractKeys(usage, ['plan', 'period', 'month', 'used', 'limit', 'remaining', 'supportId']);
    expect(usage).toMatchObject({ plan: 'family', period: 'month', used: 0, limit: null, remaining: null, supportId: userId });
    expect(usage.month).toMatch(/^\d{4}-\d{2}$/);

    writeContractFixture('ai-usage', {
      plan: usage.plan,
      period: usage.period,
      month: '2026-11',
      used: usage.used,
      limit: usage.limit,
      remaining: usage.remaining,
      supportId: 'synthetic-account',
    });
  });

  it('answers the retired passkey, account, contact and cost routes with 410', async () => {
    const { run } = await makeFixture();
    const { sessionToken } = await guestSignIn(run);
    const authorization = `Native ${sessionToken}`;
    const retired: Array<[string, string, unknown?]> = [
      ['POST', '/api/native/passkey/options', { kind: 'authenticate', keyId }],
      ['POST', '/api/native/passkey/verify', { ceremonyId: 'x', response: {}, assertion: 'x' }],
      ['GET', '/api/native/auth/get-session'],
      ['POST', '/api/native/auth/sign-out'],
      ['DELETE', '/api/native/account/delete'],
      ['POST', '/api/native/contact', { flowId: 'x' }],
      ['POST', '/api/native/contact/transcribe', { flowId: 'x' }],
      ['GET', '/api/native/ai/costs?month=2026-11'],
    ];
    for (const [method, path, body] of retired) {
      const response = await run(path, body, authorization, method);
      expect(response.status, `${method} ${path}`).toBe(410);
      expect(await response.json()).toEqual({ error: 'gone' });
    }
  });
});
