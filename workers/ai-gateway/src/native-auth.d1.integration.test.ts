import 'reflect-metadata';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { Encoder } from 'cbor-x';
import { AsnEcSignatureFormatter } from '@peculiar/x509';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleAccountRequest } from './account-auth';

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
const bootstrapSecret = 'synthetic-account-bootstrap-secret';
const migrations = readdirSync(new URL('../migrations/', import.meta.url))
  .filter(name => name.endsWith('.sql'))
  .sort()
  .map(name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
const migrationSql = migrations.map(sql => sql.replace(/^--.*$/gm, '').replace(/\s+/g, ' ').trim()).join('\n');
const instances: Miniflare[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map(instance => instance.dispose())); });

function base64url(bytes: Uint8Array | ArrayBuffer) {
  return Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString('base64url');
}
function fromBase64url(value: string) {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}
function concat(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
async function sha256(value: Uint8Array) {
  const bytes = new Uint8Array(value);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer));
}
function counterBytes(counter: number) {
  return new Uint8Array([(counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff]);
}
async function makeCredential() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  if (!jwk.x || !jwk.y) throw new Error('missing P-256 public coordinates');
  const credentialIdBytes = crypto.getRandomValues(new Uint8Array(32));
  const credentialId = base64url(credentialIdBytes);
  const cosePublicKey = new Encoder({ useRecords: true, tagUint8Array: false }).encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], [-2, fromBase64url(jwk.x)], [-3, fromBase64url(jwk.y)],
  ]));
  return { privateKey: pair.privateKey, credentialId, credentialIdBytes, cosePublicKey };
}
async function signedResponse(
  credential: Awaited<ReturnType<typeof makeCredential>>,
  challenge: string,
  { origin: clientOrigin = origin, rpId = 'native-d1.example.test', userVerified = true, counter = 1 }: {
    origin?: string; rpId?: string; userVerified?: boolean; counter?: number;
  } = {},
) {
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: 'webauthn.get', challenge, origin: clientOrigin, crossOrigin: false,
  }));
  const authenticatorData = concat(
    await sha256(new TextEncoder().encode(rpId)),
    new Uint8Array([userVerified ? 0x05 : 0x01]),
    counterBytes(counter),
  );
  const signedData = concat(authenticatorData, await sha256(clientDataJSON));
  const rawSignature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, credential.privateKey, signedData);
  const derSignature = new AsnEcSignatureFormatter().toAsnSignature(
    { name: 'ECDSA', namedCurve: 'P-256' } as EcKeyGenParams,
    rawSignature,
  );
  if (!derSignature) throw new Error('failed to convert ECDSA signature to ASN.1 DER');
  return {
    id: credential.credentialId,
    rawId: credential.credentialId,
    type: 'public-key',
    response: {
      clientDataJSON: base64url(clientDataJSON),
      authenticatorData: base64url(authenticatorData),
      signature: base64url(derSignature),
      userHandle: null,
    },
    clientExtensionResults: {},
  };
}
async function registrationResponse(credential: Awaited<ReturnType<typeof makeCredential>>, challenge: string) {
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: 'webauthn.create', challenge, origin, crossOrigin: false,
  }));
  const cose = new Uint8Array(credential.cosePublicKey);
  const credentialLength = credential.credentialIdBytes.length;
  const authenticatorData = concat(
    await sha256(new TextEncoder().encode('native-d1.example.test')),
    new Uint8Array([0x45]), // UP | UV | AT
    counterBytes(0),
    new Uint8Array(16), // AAGUID
    new Uint8Array([(credentialLength >>> 8) & 0xff, credentialLength & 0xff]),
    credential.credentialIdBytes,
    cose,
  );
  const attestationObject = new Encoder({ useRecords: true, tagUint8Array: false }).encode(new Map<string, unknown>([
    ['fmt', 'none'], ['attStmt', new Map()], ['authData', authenticatorData],
  ]));
  return {
    id: credential.credentialId,
    rawId: credential.credentialId,
    type: 'public-key',
    response: { clientDataJSON: base64url(clientDataJSON), attestationObject: base64url(attestationObject), transports: ['internal'] },
    clientExtensionResults: {},
  };
}
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
    BETTER_AUTH_SECRET: secret,
    AI_GATEWAY_AUTH_SECRET: secret,
    ACCOUNT_BOOTSTRAP_SECRET: bootstrapSecret,
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
async function seedAccountCredential(db: Awaited<ReturnType<Miniflare['getD1Database']>>, credential: Awaited<ReturnType<typeof makeCredential>>, nowSeconds: number) {
  await db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
    .bind('synthetic-account', 'Synthetic Member', 'member@example.invalid', 1, nowSeconds * 1000, nowSeconds * 1000).run();
  await db.prepare(`INSERT INTO passkey(id,name,publicKey,userId,credentialID,counter,deviceType,backedUp,transports,createdAt,aaguid)
    VALUES (?,?,?,?,?,0,'multiDevice',1,'internal',?,'synthetic-aaguid')`)
    .bind('synthetic-passkey', 'Synthetic passkey', Buffer.from(credential.cosePublicKey).toString('base64'), 'synthetic-account', credential.credentialId, nowSeconds * 1000).run();
}
type Fixture = Awaited<ReturnType<typeof makeFixture>>;
async function passkeyOptions(run: Fixture['run'], kind: 'authenticate' | 'register', context?: string) {
  const response = await run('/api/native/passkey/options', { kind, keyId, ...(context ? { context } : {}) });
  expect(response.status).toBe(200);
  return await response.json() as { ceremonyId: string; options: { challenge: string; rpId: string } };
}

async function inviteAccount(env: Fixture['env'], email: string) {
  const response = await handleAccountRequest(new Request(`${origin}/api/account/invites`, {
    method: 'POST', headers: { authorization: `Bearer ${bootstrapSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, name: 'Synthetic invited member' }),
  }), env);
  expect(response.status).toBe(201);
  return await response.json() as { context: string };
}

const fixedNow = 1_800_000_000;
describe('native auth on local D1 with real Better Auth passkey verification', () => {
  it('stores the actual Better Auth Passkey challenge and its verification cookie server-side', async () => {
    const { db, run } = await makeFixture(fixedNow);
    const response = await run('/api/native/passkey/options', { kind: 'authenticate', keyId });
    expect(response.status).toBe(200);
    const body = await response.json() as { ceremonyId: string; options: { challenge?: string; rpId?: string } };
    expect(body.ceremonyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.options.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.options.rpId).toBe('native-d1.example.test');

    const stored = await db.prepare('SELECT challenge,purpose,key_id,ceremony_kind,verification_cookie,expires_at FROM native_challenges WHERE id=?')
      .bind(body.ceremonyId).first<{ challenge: string; purpose: string; key_id: string; ceremony_kind: string; verification_cookie: string; expires_at: number }>();
    expect(stored).toMatchObject({
      challenge: body.options.challenge,
      purpose: 'passkey',
      key_id: keyId,
      ceremony_kind: 'authenticate',
      expires_at: fixedNow + 120,
    });
    expect(stored?.verification_cookie).toMatch(/^__Secure-better-auth\.better-auth-passkey=/);
    expect(JSON.stringify(body)).not.toContain(stored!.verification_cookie.split('=')[1]);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('rejects mixing account sessions and another account invite without consuming that invite', async () => {
    const { db, env, run, nowSeconds } = await makeFixture();
    const credential = await makeCredential();
    await seedAccountCredential(db, credential, nowSeconds);
    const ceremony = await passkeyOptions(run, 'authenticate');
    const loginResponse = await run('/api/native/passkey/verify', {
      ceremonyId: ceremony.ceremonyId, response: await signedResponse(credential, ceremony.options.challenge), assertion: 'proof',
    });
    expect(loginResponse.status).toBe(200);
    const login = await loginResponse.json() as { sessionToken: string };
    const invite = await inviteAccount(env, 'other-member@example.invalid');
    expect((await run('/api/native/passkey/options', { kind: 'register', keyId, context: invite.context }, `Native ${login.sessionToken}`)).status).toBe(400);
    expect((await run('/api/native/passkey/options', { kind: 'register', keyId, context: invite.context })).status).toBe(403);
    expect(await db.prepare("SELECT used_at FROM account_invite WHERE user_id=(SELECT id FROM user WHERE email='other-member@example.invalid')").first()).toEqual({ used_at: null });
    expect((await db.prepare('SELECT COUNT(*) AS count FROM passkey').first<{ count: number }>())!.count).toBe(1);
  });

  it('claims an invitation target only after proof and never consumes a competing account invite', async () => {
    const { db, env, run } = await makeFixture();
    const first = await inviteAccount(env, 'first-invite@example.invalid');
    const second = await inviteAccount(env, 'second-invite@example.invalid');
    const firstCeremony = await passkeyOptions(run, 'register', first.context);
    const secondCeremony = await passkeyOptions(run, 'register', second.context);
    expect(await db.prepare('SELECT account_user_id FROM native_app_keys').first()).toEqual({ account_user_id: null });
    // Valid App Attest proof claims the server-resolved target, but a bad Passkey
    // response must not create a session or consume the invitation.
    expect((await run('/api/native/passkey/verify', { ceremonyId: firstCeremony.ceremonyId, response: {}, assertion: 'proof' })).status).not.toBe(200);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM session').first<{ count: number }>())!.count).toBe(0);
    const secondCredential = await makeCredential();
    expect((await run('/api/native/passkey/verify', { ceremonyId: secondCeremony.ceremonyId,
      response: await registrationResponse(secondCredential, secondCeremony.options.challenge), assertion: 'proof' })).status).toBe(403);
    const invites = await db.prepare('SELECT used_at FROM account_invite').all<{ used_at: number | null }>();
    expect(invites.results).toEqual([{ used_at: null }, { used_at: null }]);
    // Retrying the original invite with a fresh ceremony still succeeds.
    const retry = await passkeyOptions(run, 'register', first.context);
    const firstCredential = await makeCredential();
    expect((await run('/api/native/passkey/verify', { ceremonyId: retry.ceremonyId,
      response: await registrationResponse(firstCredential, retry.options.challenge), assertion: 'proof' })).status).toBe(200);
    expect(await db.prepare("SELECT used_at FROM account_invite WHERE user_id=(SELECT id FROM user WHERE email='second-invite@example.invalid')").first()).toEqual({ used_at: null });
  });

  it('verifies a real ES256 assertion, issues an AI token, and revokes access on native logout', async () => {
    const { db, run, nowSeconds } = await makeFixture();
    const credential = await makeCredential();
    await seedAccountCredential(db, credential, nowSeconds);
    const ceremony = await passkeyOptions(run, 'authenticate');
    expect(ceremony.options.rpId).toBe('native-d1.example.test');
    const response = await signedResponse(credential, ceremony.options.challenge);
    const loginResponse = await run('/api/native/passkey/verify', {
      ceremonyId: ceremony.ceremonyId, response, assertion: 'synthetic-app-attest-assertion',
    });
    expect(loginResponse.status).toBe(200);
    const login = await loginResponse.json() as { sessionToken: string; expiresAt: number };
    expect(login.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(login.expiresAt).toBeGreaterThan(nowSeconds);
    expect(await db.prepare('SELECT account_user_id FROM native_app_keys WHERE key_id=?').bind(keyId).first())
      .toEqual({ account_user_id: 'synthetic-account' });

    const authorization = `Native ${login.sessionToken}`;
    const tokenChallengeResponse = await run('/api/native/challenge', { purpose: 'token', keyId }, authorization);
    expect(tokenChallengeResponse.status).toBe(200);
    const tokenChallenge = await tokenChallengeResponse.json() as { challengeId: string };
    const tokenResponse = await run('/api/native/ai/token', {
      challengeId: tokenChallenge.challengeId, keyId, assertion: 'synthetic-app-attest-token-assertion',
    }, authorization);
    expect(tokenResponse.status).toBe(200);
    const access = await tokenResponse.json() as { token: string; expiresAt: number };
    expect(access.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const sessionResponse = await run('/api/native/auth/get-session', undefined, authorization);
    expect(sessionResponse.status).toBe(200);
    const sessionBody = await sessionResponse.json() as { session: { token: string; id: string }; user: { id: string } };
    expect(sessionBody.session.token).toBe(login.sessionToken);
    expect(sessionBody.user.id).toBe('synthetic-account');
    expect(sessionResponse.headers.get('set-cookie')).toBeNull();
    const webSession = await db.prepare('SELECT token FROM session WHERE userId=?').bind('synthetic-account').first<{ token: string }>();
    expect(JSON.stringify(sessionBody)).not.toContain(webSession!.token);

    const listResponse = await run('/api/native/auth/passkey/list-user-passkeys', undefined, authorization);
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json() as Array<{ credentialID: string; userId: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ credentialID: credential.credentialId, userId: 'synthetic-account' });
    expect(listResponse.headers.get('set-cookie')).toBeNull();

    const logoutResponse = await run('/api/native/auth/sign-out', undefined, authorization, 'POST');
    expect(logoutResponse.status).toBe(200);
    expect(logoutResponse.headers.get('set-cookie')).toBeNull();
    expect((await run('/api/native/auth/get-session', undefined, authorization)).status).toBe(401);
    const revokedAiResponse = await run('/api/native/ai/gemini', {}, `Bearer ${access.token}`);
    expect(revokedAiResponse.status).toBe(401);
  });

  it('rejects assertions without UV, with a wrong origin, with a wrong RP, and after ceremony expiry', async () => {
    const { db, run, nowSeconds } = await makeFixture();
    const credential = await makeCredential();
    await seedAccountCredential(db, credential, nowSeconds);

    const invalidAssertions = [
      { label: 'missing user verification', options: { userVerified: false } },
      { label: 'wrong origin', options: { origin: 'https://attacker.example.test' } },
      { label: 'wrong RP ID', options: { rpId: 'attacker.example.test' } },
    ];
    for (const invalid of invalidAssertions) {
      const ceremony = await passkeyOptions(run, 'authenticate');
      const response = await signedResponse(credential, ceremony.options.challenge, invalid.options);
      const verified = await run('/api/native/passkey/verify', {
        ceremonyId: ceremony.ceremonyId, response, assertion: `synthetic-${invalid.label}`,
      });
      expect(verified.status, invalid.label).not.toBe(200);
    }

    const expiredCeremony = await passkeyOptions(run, 'authenticate');
    const validResponse = await signedResponse(credential, expiredCeremony.options.challenge);
    const expired = await run('/api/native/passkey/verify', {
      ceremonyId: expiredCeremony.ceremonyId, response: validResponse, assertion: 'synthetic-expired-assertion',
    }, undefined, 'POST', nowSeconds + 121);
    expect(expired.status).toBe(403);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM native_sessions').first()).toEqual({ count: 0 });
  });

  it('registers an invited account with a real none-attestation credential and rejects invite reuse', async () => {
    const { db, env, run } = await makeFixture();
    const inviteResponse = await handleAccountRequest(new Request(`${origin}/api/account/invites`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bootstrapSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'invited-member@example.invalid', name: 'Invited Member' }),
    }), env);
    expect(inviteResponse.status).toBe(201);
    const invite = await inviteResponse.json() as { context: string };
    const ceremony = await passkeyOptions(run, 'register', invite.context);
    const credential = await makeCredential();
    const response = await registrationResponse(credential, ceremony.options.challenge);
    const verified = await run('/api/native/passkey/verify', {
      ceremonyId: ceremony.ceremonyId, response, name: 'Synthetic passkey', assertion: 'synthetic-app-attest-registration-assertion',
    });
    expect(verified.status).toBe(200);
    const session = await verified.json() as { sessionToken: string };
    expect(session.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await db.prepare('SELECT email FROM user WHERE id=(SELECT account_user_id FROM native_app_keys WHERE key_id=?)')
      .bind(keyId).first()).toEqual({ email: 'invited-member@example.invalid' });
    expect(await db.prepare('SELECT credentialID,counter,deviceType,backedUp FROM passkey WHERE userId=(SELECT account_user_id FROM native_app_keys WHERE key_id=?)')
      .bind(keyId).first()).toEqual({ credentialID: credential.credentialId, counter: 0, deviceType: 'singleDevice', backedUp: 0 });
    const consumedInvite = await db.prepare('SELECT used_at FROM account_invite WHERE user_id=(SELECT account_user_id FROM native_app_keys WHERE key_id=?)')
      .bind(keyId).first<{ used_at: number | null }>();
    expect(consumedInvite?.used_at).not.toBeNull();

    const reusedInvite = await run('/api/native/passkey/options', { kind: 'register', keyId, context: invite.context });
    expect(reusedInvite.status).not.toBe(200);
  });

  it('invalidates native sessions through account recovery and account deletion', async () => {
    const recovery = await makeFixture();
    const recoveryCredential = await makeCredential();
    await seedAccountCredential(recovery.db, recoveryCredential, recovery.nowSeconds);
    const recoveryCeremony = await passkeyOptions(recovery.run, 'authenticate');
    const recoveryLogin = await recovery.run('/api/native/passkey/verify', {
      ceremonyId: recoveryCeremony.ceremonyId,
      response: await signedResponse(recoveryCredential, recoveryCeremony.options.challenge),
      assertion: 'synthetic-app-attest-recovery-assertion',
    });
    expect(recoveryLogin.status).toBe(200);
    const recoverySession = await recoveryLogin.json() as { sessionToken: string };
    const recoveryResponse = await handleAccountRequest(new Request(`${origin}/api/account/recovery`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bootstrapSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.invalid' }),
    }), recovery.env);
    expect(recoveryResponse.status).toBe(201);
    expect((await recovery.run('/api/native/auth/get-session', undefined, `Native ${recoverySession.sessionToken}`)).status).toBe(401);
    expect(await recovery.db.prepare('SELECT COUNT(*) AS count FROM passkey WHERE userId=?').bind('synthetic-account').first()).toEqual({ count: 0 });

    const deletion = await makeFixture();
    const deletionCredential = await makeCredential();
    await seedAccountCredential(deletion.db, deletionCredential, deletion.nowSeconds);
    const deletionCeremony = await passkeyOptions(deletion.run, 'authenticate');
    const deletionLoginResponse = await deletion.run('/api/native/passkey/verify', {
      ceremonyId: deletionCeremony.ceremonyId,
      response: await signedResponse(deletionCredential, deletionCeremony.options.challenge),
      assertion: 'synthetic-app-attest-delete-assertion',
    });
    expect(deletionLoginResponse.status).toBe(200);
    const deletionLogin = await deletionLoginResponse.json() as { sessionToken: string };
    const deleted = await deletion.run('/api/native/account/delete', undefined, `Native ${deletionLogin.sessionToken}`, 'DELETE');
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, localHouseholdDataPreserved: true });
    expect((await deletion.run('/api/native/auth/get-session', undefined, `Native ${deletionLogin.sessionToken}`)).status).toBe(401);
  });
});
