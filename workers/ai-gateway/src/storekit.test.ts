import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleNativeRequest, type NativeEnv } from './native-auth';
import { sqliteD1 } from './test-support/sqlite-d1';
import {
  buildStoreKitChainFixture,
  buildStoreKitJwsFixture,
  storeKitTestNow,
  type StoreKitChainFixture,
} from './test-support/storekit-fixture';

const ORIGIN = 'https://native.example.test';
const SECRET = 'synthetic-native-secret-with-32-chars!!';
const NOW = Math.floor(storeKitTestNow.getTime() / 1000);
const PRODUCT_PLANS_JSON = JSON.stringify({
  'jp.kakeimatch.pro.monthly': { plan: 'pro', monthlyAiLimit: 100 },
});

let sqlite: DatabaseSync;
let env: NativeEnv;
let chain: StoreKitChainFixture;

function tokenHashBase64Url(token: string): string {
  return createHash('sha256')
    .update(token)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function seedNativeSession(userId: string, tokenSeed: string): string {
  const token = tokenSeed.padEnd(43, 'a').slice(0, 43);
  const keyId = createHash('sha256').update(`key:${userId}`).digest('base64');
  sqlite
    .prepare('INSERT INTO user(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)')
    .run(userId, 'Guest', `${userId}@guest.kakeimatch.invalid`, NOW * 1000, NOW * 1000);
  sqlite
    .prepare(
      `INSERT INTO native_app_keys(key_id, origin, app_id, environment, public_key, receipt, counter, guest_user_id, created_at)
       VALUES (?, ?, ?, 'development', 'pub', 'rcpt', 0, ?, ?)`,
    )
    .run(keyId, ORIGIN, 'ABCDE12345.jp.kakeimatch.ios', userId, NOW);
  sqlite
    .prepare(
      `INSERT INTO native_sessions(token_hash, key_id, user_id, identity, created_at, expires_at)
       VALUES (?, ?, ?, 'guest', ?, ?)`,
    )
    .run(tokenHashBase64Url(token), keyId, userId, NOW, NOW + 3600);
  return token;
}

function postTransaction(token: string, body: unknown, extraHeaders?: Record<string, string>) {
  return new Request(`${ORIGIN}/api/native/storekit/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Native ${token}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(dir).filter(entry => entry.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
  }
  chain = await buildStoreKitChainFixture();
  env = {
    ACCOUNT_DB: sqliteD1(sqlite),
    CLOUD_ACCOUNT_ORIGIN: ORIGIN,
    AI_GATEWAY_AUTH_SECRET: SECRET,
    AI_USER_RATE_LIMIT: { limit: async () => ({ success: true }) },
    NATIVE_APP_TEAM_ID: 'ABCDE12345',
    NATIVE_APP_ID: 'ABCDE12345.jp.kakeimatch.ios',
    NATIVE_APP_ORIGIN: ORIGIN,
    NATIVE_APP_RP_ID: 'native.example.test',
    NATIVE_APP_ATTEST_ENVIRONMENT: 'development',
    STOREKIT_ALLOWED_ENVIRONMENTS: 'Sandbox',
    STOREKIT_PRODUCT_PLANS_JSON: PRODUCT_PLANS_JSON,
  };
});

describe('POST /api/native/storekit/transactions', () => {
  it('returns 503 not_configured when StoreKit bindings are missing', async () => {
    const token = seedNativeSession('user-a', 'tok-a');
    const fixture = await buildStoreKitJwsFixture({ chain });
    const unconfigured: NativeEnv = { ...env, STOREKIT_PRODUCT_PLANS_JSON: undefined };

    const response = await handleNativeRequest(
      postTransaction(token, { signedTransactionInfo: fixture.jws }),
      unconfigured,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'not_configured' });
  });

  it('rejects Origin/Cookie headers, unknown body keys, invalid JWS, Production env, FAMILY_SHARED, and unknown products', async () => {
    const token = seedNativeSession('user-a', 'tok-a');
    const valid = await buildStoreKitJwsFixture({ chain });

    const withOrigin = await handleNativeRequest(
      postTransaction(token, { signedTransactionInfo: valid.jws }, { origin: ORIGIN }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(withOrigin.status).toBe(403);

    const extraKey = await handleNativeRequest(
      postTransaction(token, { signedTransactionInfo: valid.jws, extra: true }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(extraKey.status).toBe(400);

    const badJws = await handleNativeRequest(
      postTransaction(token, { signedTransactionInfo: 'not-a-jws' }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(badJws.status).toBe(403);
    expect(await badJws.json()).toEqual({ error: 'invalid_jws' });

    const prodFixture = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: { environment: 'Production' },
    });
    const prodRes = await handleNativeRequest(
      postTransaction(token, { signedTransactionInfo: prodFixture.jws }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(prodRes.status).toBe(403);
    expect(await prodRes.json()).toEqual({ error: 'environment_not_allowed' });

    const familyShared = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: { inAppOwnershipType: 'FAMILY_SHARED' },
    });
    const familyRes = await handleNativeRequest(
      postTransaction(token, { signedTransactionInfo: familyShared.jws }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(familyRes.status).toBe(403);
    expect(await familyRes.json()).toEqual({ error: 'unsupported_ownership_type' });

    const unknownProduct = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: { productId: 'jp.kakeimatch.unknown' },
    });
    const unknownRes = await handleNativeRequest(
      postTransaction(token, { signedTransactionInfo: unknownProduct.jws }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(unknownRes.status).toBe(422);
    expect(await unknownRes.json()).toEqual({ error: 'unknown_product' });
  });

  it('inserts a new subscription row on first valid POST', async () => {
    const token = seedNativeSession('user-a', 'tok-a');
    const fixture = await buildStoreKitJwsFixture({ chain });

    const response = await handleNativeRequest(
      postTransaction(token, { signedTransactionInfo: fixture.jws }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );

    expect(response.status).toBe(200);
    const row = sqlite
      .prepare('SELECT user_id, environment, product_id, status, owner_change_count, last_owner_changed_at FROM store_subscriptions WHERE original_transaction_id = ?')
      .get('1000000000000001') as Record<string, unknown>;
    expect(row).toEqual({
      user_id: 'user-a',
      environment: 'Sandbox',
      product_id: 'jp.kakeimatch.pro.monthly',
      status: 'active',
      owner_change_count: 0,
      last_owner_changed_at: null,
    });
  });

  it('rebinds owner only when signedDate is within 10 minutes and enforces 24-hour cooldown', async () => {
    const tokenA = seedNativeSession('user-a', 'tok-a');
    const tokenB = seedNativeSession('user-b', 'tok-b');
    const tokenC = seedNativeSession('user-c', 'tok-c');

    const initial = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: { signedDate: (NOW - 30) * 1000 },
    });
    expect(
      (
        await handleNativeRequest(
          postTransaction(tokenA, { signedTransactionInfo: initial.jws }),
          env,
          { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
        )
      ).status,
    ).toBe(200);

    // Stale JWS (> 10 minutes old) must NOT transfer ownership or update state.
    const staleTransfer = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        signedDate: (NOW - 11 * 60) * 1000,
        expiresDate: (NOW + 60 * 86400) * 1000,
      },
    });
    const staleRes = await handleNativeRequest(
      postTransaction(tokenB, { signedTransactionInfo: staleTransfer.jws }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(staleRes.status).toBe(200);
    const afterStale = sqlite
      .prepare('SELECT user_id, owner_change_count, last_owner_changed_at, expires_at FROM store_subscriptions WHERE original_transaction_id = ?')
      .get('1000000000000001') as Record<string, unknown>;
    expect(afterStale.user_id).toBe('user-a');
    expect(afterStale.owner_change_count).toBe(0);
    expect(afterStale.last_owner_changed_at).toBeNull();

    // Fresh JWS (<= 10 minutes old) transfers ownership, increments count, logs without identifiers.
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const freshTransfer = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: { signedDate: (NOW - 5) * 1000 },
    });
    const freshRes = await handleNativeRequest(
      postTransaction(tokenB, { signedTransactionInfo: freshTransfer.jws }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(freshRes.status).toBe(200);
    const afterFresh = sqlite
      .prepare('SELECT user_id, owner_change_count, last_owner_changed_at FROM store_subscriptions WHERE original_transaction_id = ?')
      .get('1000000000000001') as Record<string, unknown>;
    expect(afterFresh).toEqual({
      user_id: 'user-b',
      owner_change_count: 1,
      last_owner_changed_at: NOW,
    });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(infoSpy.mock.calls[0]);
    expect(logged).not.toContain('user-a');
    expect(logged).not.toContain('user-b');
    expect(logged).not.toContain('1000000000000001');
    infoSpy.mockRestore();

    // Second owner change within 24 hours must NOT take effect.
    const secondNow = NOW + 60;
    const secondTransfer = await buildStoreKitJwsFixture({
      chain,
      now: new Date(secondNow * 1000),
      payloadOverrides: { signedDate: (secondNow - 5) * 1000 },
    });
    const secondRes = await handleNativeRequest(
      postTransaction(tokenC, { signedTransactionInfo: secondTransfer.jws }),
      env,
      { nowSeconds: () => secondNow, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(secondRes.status).toBe(200);
    const afterSecond = sqlite
      .prepare('SELECT user_id, owner_change_count FROM store_subscriptions WHERE original_transaction_id = ?')
      .get('1000000000000001') as Record<string, unknown>;
    expect(afterSecond).toEqual({ user_id: 'user-b', owner_change_count: 1 });
  });

  it('never downgrades status or clears revoked_at on client POST', async () => {
    const token = seedNativeSession('user-a', 'tok-a');
    const initial = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        signedDate: (NOW - 60) * 1000,
        expiresDate: (NOW + 30 * 86400) * 1000,
      },
    });
    await handleNativeRequest(
      postTransaction(token, { signedTransactionInfo: initial.jws }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );

    // Client POST with an expired/revoked payload must NOT downgrade an active row.
    const downgradeAttempt = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        signedDate: (NOW - 10) * 1000,
        expiresDate: (NOW - 3600) * 1000,
        revocationDate: (NOW - 100) * 1000,
        revocationReason: 1,
      },
    });
    await handleNativeRequest(
      postTransaction(token, { signedTransactionInfo: downgradeAttempt.jws }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    const afterDowngrade = sqlite
      .prepare('SELECT status, expires_at, revoked_at FROM store_subscriptions WHERE original_transaction_id = ?')
      .get('1000000000000001') as Record<string, unknown>;
    expect(afterDowngrade).toEqual({
      status: 'active',
      expires_at: NOW + 30 * 86400,
      revoked_at: null,
    });

    // Once revoked_at is set (e.g. by server notification/cron), client POST must never clear it.
    sqlite
      .prepare("UPDATE store_subscriptions SET status = 'revoked', revoked_at = ?, revocation_reason = 1 WHERE original_transaction_id = ?")
      .run(NOW - 50, '1000000000000001');

    const reviveAttempt = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        signedDate: NOW * 1000,
        expiresDate: (NOW + 90 * 86400) * 1000,
      },
    });
    await handleNativeRequest(
      postTransaction(token, { signedTransactionInfo: reviveAttempt.jws }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    const afterRevive = sqlite
      .prepare('SELECT status, revoked_at, revocation_reason FROM store_subscriptions WHERE original_transaction_id = ?')
      .get('1000000000000001') as Record<string, unknown>;
    expect(afterRevive).toEqual({
      status: 'revoked',
      revoked_at: NOW - 50,
      revocation_reason: 1,
    });
  });
});
