import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAppStoreServerApiJwt,
  fetchAllSubscriptionStatuses,
  StoreKitApiError,
  type StoreKitApiConfig,
} from './storekit-api';
import {
  reconcileStoreSubscriptions,
  type StoreKitReconcileEnv,
} from './storekit-reconcile';
import { sqliteD1 } from './test-support/sqlite-d1';
import {
  buildStoreKitChainFixture,
  buildStoreKitJwsFixture,
  storeKitTestNow,
  type StoreKitChainFixture,
} from './test-support/storekit-fixture';

const NOW = Math.floor(storeKitTestNow.getTime() / 1000);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = 'jp.kakeimatch.pro.monthly';
const PRODUCT_PLANS_JSON = JSON.stringify({
  [PRODUCT_ID]: { plan: 'pro', monthlyAiLimit: 100 },
});
const ISSUER_ID = '00000000-0000-4000-8000-000000000001';
const KEY_ID = 'SYNTHKEY01';

const encoder = new TextEncoder();

let sqlite: DatabaseSync;
let chain: StoreKitChainFixture;
let apiKeyPair: CryptoKeyPair;
let apiPrivateKeyPem: string;
let env: StoreKitReconcileEnv;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64Url(bytes: Uint8Array): string {
  return base64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

async function generateSyntheticPkcs8Pem(): Promise<{ keyPair: CryptoKeyPair; pem: string }> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64(pkcs8)}\n-----END PRIVATE KEY-----`;
  return { keyPair, pem };
}

async function signCustomJws(signingChain: StoreKitChainFixture, payload: Record<string, unknown>): Promise<string> {
  const header = {
    alg: 'ES256',
    x5c: [
      base64(signingChain.leafDER),
      base64(signingChain.intermediateDER),
      base64(signingChain.rootDER),
    ],
  };
  const encodedHeader = base64Url(encoder.encode(JSON.stringify(header)));
  const encodedPayload = base64Url(encoder.encode(JSON.stringify(payload)));
  const signingInput = encoder.encode(`${encodedHeader}.${encodedPayload}`);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingChain.leafPrivateKey,
      signingInput.slice().buffer as ArrayBuffer,
    ),
  );
  return `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`;
}

function seedSubscription(params: {
  originalTransactionId: string;
  status: string;
  expiresAt: number | null;
  revokedAt?: number | null;
  latestSignedDateMs?: number;
  lastReconciledAt?: number | null;
}) {
  sqlite
    .prepare(
      `INSERT INTO store_subscriptions (
         original_transaction_id, user_id, environment, product_id, status, expires_at,
         in_app_ownership_type, revoked_at, revocation_reason, latest_transaction_id,
         latest_signed_date_ms, auto_renew_status, owner_change_count, last_owner_changed_at,
         last_reconciled_at, created_at, updated_at
       ) VALUES (?, ?, 'Sandbox', ?, ?, ?, 'PURCHASED', ?, NULL, '2000000000000001', ?, 1, 0, NULL, ?, ?, ?)`,
    )
    .run(
      params.originalTransactionId,
      USER_ID,
      PRODUCT_ID,
      params.status,
      params.expiresAt,
      params.revokedAt ?? null,
      params.latestSignedDateMs ?? (NOW - 3600) * 1000,
      params.lastReconciledAt ?? null,
      NOW - 3600,
      NOW - 3600,
    );
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(dir).filter(entry => entry.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
  }
  sqlite
    .prepare('INSERT INTO user(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)')
    .run(USER_ID, 'User', `${USER_ID}@example.invalid`, NOW * 1000, NOW * 1000);

  chain = await buildStoreKitChainFixture();
  const generated = await generateSyntheticPkcs8Pem();
  apiKeyPair = generated.keyPair;
  apiPrivateKeyPem = generated.pem;
  env = {
    ACCOUNT_DB: sqliteD1(sqlite),
    STOREKIT_ALLOWED_ENVIRONMENTS: 'Sandbox',
    STOREKIT_PRODUCT_PLANS_JSON: PRODUCT_PLANS_JSON,
    APP_STORE_SERVER_API_PRIVATE_KEY: apiPrivateKeyPem,
    APP_STORE_SERVER_API_ISSUER_ID: ISSUER_ID,
    APP_STORE_SERVER_API_KEY_ID: KEY_ID,
  };
});

describe('App Store Server API JWT & client', () => {
  it('generates a valid ES256 JWT verifiable by the corresponding P-256 public key', async () => {
    const config: StoreKitApiConfig = {
      privateKeyPem: apiPrivateKeyPem,
      issuerId: ISSUER_ID,
      keyId: KEY_ID,
    };
    const jwt = await createAppStoreServerApiJwt(config, {
      nowSeconds: () => NOW,
      ttlSeconds: 300,
    });

    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
    const signature = decodeBase64Url(parts[2]);

    expect(header).toEqual({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
    expect(payload).toEqual({
      iss: ISSUER_ID,
      iat: NOW,
      exp: NOW + 300,
      aud: 'appstoreconnect-v1',
      bid: 'jp.kakeimatch.ios',
    });

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      apiKeyPair.publicKey,
      signature.slice().buffer as ArrayBuffer,
      encoder.encode(`${parts[0]}.${parts[1]}`).slice().buffer as ArrayBuffer,
    );
    expect(valid).toBe(true);
  });

  it('calls the Sandbox/Production Get All Subscription Statuses endpoint and handles 404 and errors', async () => {
    const config: StoreKitApiConfig = {
      privateKeyPem: apiPrivateKeyPem,
      issuerId: ISSUER_ID,
      keyId: KEY_ID,
    };
    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      expect(url).toBe('https://api.storekit-sandbox.itunes.apple.com/inApps/v1/subscriptions/1000000000000001');
      const auth = new Headers(init?.headers).get('authorization');
      expect(auth).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      return Response.json({
        environment: 'Sandbox',
        bundleId: 'jp.kakeimatch.ios',
        data: [
          {
            subscriptionGroupIdentifier: 'group-1',
            lastTransactions: [
              {
                originalTransactionId: '1000000000000001',
                status: 1,
                signedTransactionInfo: 'tx.jws.token',
                signedRenewalInfo: 'ren.jws.token',
              },
            ],
          },
        ],
      });
    });

    const result = await fetchAllSubscriptionStatuses(config, '1000000000000001', 'Sandbox', {
      fetch: mockFetch,
      nowSeconds: () => NOW,
    });
    expect(result).toEqual({
      found: true,
      environment: 'Sandbox',
      items: [
        {
          originalTransactionId: '1000000000000001',
          appleStatus: 1,
          signedTransactionInfo: 'tx.jws.token',
          signedRenewalInfo: 'ren.jws.token',
        },
      ],
    });

    const notFound = await fetchAllSubscriptionStatuses(config, '1000000000000002', 'Production', {
      fetch: vi.fn<typeof fetch>(async input => {
        expect(String(input)).toBe('https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/1000000000000002');
        return new Response(null, { status: 404 });
      }),
      nowSeconds: () => NOW,
    });
    expect(notFound).toEqual({ found: false, environment: 'Production', items: [] });

    await expect(
      fetchAllSubscriptionStatuses(config, '1000000000000003', 'Sandbox', {
        fetch: vi.fn<typeof fetch>(async () => Response.json({ errorCode: 4040010 }, { status: 500 })),
        nowSeconds: () => NOW,
      }),
    ).rejects.toThrow(StoreKitApiError);
  });
});

describe('reconcileStoreSubscriptions', () => {
  it('skips cleanly when App Store Server API credentials are not configured', async () => {
    seedSubscription({ originalTransactionId: '1000000000000001', status: 'active', expiresAt: NOW - 60 });
    const mockFetch = vi.fn<typeof fetch>();
    const summary = await reconcileStoreSubscriptions(
      { ...env, APP_STORE_SERVER_API_PRIVATE_KEY: undefined },
      NOW,
      { fetch: mockFetch, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(summary).toEqual({ skipped: true, checked: 0, updated: 0, unchanged: 0, errors: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('heals missed renewals, expirations, grace periods, and revocations while preserving invariants', async () => {
    // 1. Missed renewal: expired locally, Apple says active with extended expiry
    seedSubscription({ originalTransactionId: 'tx-missed-renew', status: 'expired', expiresAt: NOW - 3600 });
    // 2. Missed revocation: active locally, Apple says revoked
    seedSubscription({ originalTransactionId: 'tx-missed-revoke', status: 'active', expiresAt: NOW + 86400 });
    // 3. Missed grace period: active past expiry locally, Apple says status=4 (in_grace_period)
    seedSubscription({ originalTransactionId: 'tx-missed-grace', status: 'active', expiresAt: NOW - 120 });
    // 4. Stale API response: DB has newer latest_signed_date_ms -> must NOT be overwritten
    seedSubscription({
      originalTransactionId: 'tx-stale-api',
      status: 'active',
      expiresAt: NOW + 10 * 86400,
      latestSignedDateMs: (NOW - 10) * 1000,
    });
    // 5. Already revoked row: must never be queried or un-revoked
    seedSubscription({
      originalTransactionId: 'tx-already-revoked',
      status: 'revoked',
      expiresAt: NOW + 10 * 86400,
      revokedAt: NOW - 500,
    });
    // 6. Upstream error row: error must be isolated so other rows still reconcile
    seedSubscription({ originalTransactionId: 'tx-api-error', status: 'active', expiresAt: NOW - 60 });

    const renewedExpiresSec = NOW + 30 * 86400;
    const graceExpiresSec = NOW + 5 * 86400;
    const revokedSec = NOW - 30;

    const jwsRenewed = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        originalTransactionId: 'tx-missed-renew',
        transactionId: '2000000000000101',
        signedDate: (NOW - 60) * 1000,
        expiresDate: renewedExpiresSec * 1000,
      },
    });
    const renRenewed = await signCustomJws(chain, {
      originalTransactionId: 'tx-missed-renew',
      autoRenewStatus: 1,
      signedDate: (NOW - 50) * 1000,
    });

    const jwsRevoked = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        originalTransactionId: 'tx-missed-revoke',
        transactionId: '2000000000000102',
        signedDate: (NOW - 30) * 1000,
        revocationDate: revokedSec * 1000,
        revocationReason: 1,
      },
    });

    const jwsGrace = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        originalTransactionId: 'tx-missed-grace',
        transactionId: '2000000000000103',
        signedDate: (NOW - 120) * 1000,
        expiresDate: (NOW - 120) * 1000,
      },
    });
    const renGrace = await signCustomJws(chain, {
      originalTransactionId: 'tx-missed-grace',
      autoRenewStatus: 1,
      gracePeriodExpiresDate: graceExpiresSec * 1000,
      signedDate: (NOW - 100) * 1000,
    });

    const jwsStale = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        originalTransactionId: 'tx-stale-api',
        transactionId: '2000000000000104',
        signedDate: (NOW - 500) * 1000,
        expiresDate: (NOW - 400) * 1000,
      },
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const queriedIds: string[] = [];

    const mockFetch = vi.fn<typeof fetch>(async input => {
      const id = decodeURIComponent(String(input).split('/').pop() ?? '');
      queriedIds.push(id);
      if (id === 'tx-api-error') {
        return new Response('upstream error', { status: 503 });
      }
      const map: Record<string, { status: number; tx: string; ren?: string }> = {
        'tx-missed-renew': { status: 1, tx: jwsRenewed.jws, ren: renRenewed },
        'tx-missed-revoke': { status: 5, tx: jwsRevoked.jws },
        'tx-missed-grace': { status: 4, tx: jwsGrace.jws, ren: renGrace },
        'tx-stale-api': { status: 2, tx: jwsStale.jws },
      };
      const entry = map[id];
      return Response.json({
        environment: 'Sandbox',
        bundleId: 'jp.kakeimatch.ios',
        data: [
          {
            subscriptionGroupIdentifier: 'group-1',
            lastTransactions: [
              {
                originalTransactionId: id,
                status: entry.status,
                signedTransactionInfo: entry.tx,
                signedRenewalInfo: entry.ren,
              },
            ],
          },
        ],
      });
    });

    const summary = await reconcileStoreSubscriptions(env, NOW, {
      fetch: mockFetch,
      storeKitTestTrustAnchor: chain.rootDER,
    });
    warnSpy.mockRestore();

    expect(summary).toEqual({ skipped: false, checked: 5, updated: 3, unchanged: 1, errors: 1 });
    expect(queriedIds).not.toContain('tx-already-revoked');

    expect(
      sqlite
        .prepare('SELECT status, expires_at, latest_transaction_id, last_reconciled_at FROM store_subscriptions WHERE original_transaction_id = ?')
        .get('tx-missed-renew'),
    ).toEqual({
      status: 'active',
      expires_at: renewedExpiresSec,
      latest_transaction_id: '2000000000000101',
      last_reconciled_at: NOW,
    });

    expect(
      sqlite
        .prepare('SELECT status, revoked_at, revocation_reason, last_reconciled_at FROM store_subscriptions WHERE original_transaction_id = ?')
        .get('tx-missed-revoke'),
    ).toEqual({
      status: 'revoked',
      revoked_at: revokedSec,
      revocation_reason: 1,
      last_reconciled_at: NOW,
    });

    expect(
      sqlite
        .prepare('SELECT status, expires_at, last_reconciled_at FROM store_subscriptions WHERE original_transaction_id = ?')
        .get('tx-missed-grace'),
    ).toEqual({
      status: 'in_grace_period',
      expires_at: graceExpiresSec,
      last_reconciled_at: NOW,
    });

    // Stale API response did NOT downgrade tx-stale-api, only updated last_reconciled_at
    expect(
      sqlite
        .prepare('SELECT status, expires_at, last_reconciled_at FROM store_subscriptions WHERE original_transaction_id = ?')
        .get('tx-stale-api'),
    ).toEqual({
      status: 'active',
      expires_at: NOW + 10 * 86400,
      last_reconciled_at: NOW,
    });
  });
});
