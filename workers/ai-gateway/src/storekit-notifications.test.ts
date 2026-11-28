import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  handleStoreKitNotificationRequest,
  type StoreKitNotificationsEnv,
} from './storekit-notifications';
import { sqliteD1 } from './test-support/sqlite-d1';
import {
  buildStoreKitChainFixture,
  buildStoreKitJwsFixture,
  storeKitTestNow,
  type StoreKitChainFixture,
} from './test-support/storekit-fixture';

const NOW = Math.floor(storeKitTestNow.getTime() / 1000);
const USER_UUID = '11111111-1111-4111-8111-111111111111';
const ORIG_TX_ID = '1000000000000001';
const PRODUCT_ID = 'jp.kakeimatch.pro.monthly';
const PRODUCT_PLANS_JSON = JSON.stringify({
  [PRODUCT_ID]: { plan: 'pro', monthlyAiLimit: 100 },
});

const encoder = new TextEncoder();

let sqlite: DatabaseSync;
let env: StoreKitNotificationsEnv;
let chain: StoreKitChainFixture;

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

async function signPayload(
  signingChain: StoreKitChainFixture,
  payload: Record<string, unknown>,
  options: { tamperSignature?: boolean } = {},
): Promise<string> {
  const alg = signingChain.leafCurve === 'P-384' ? 'ES384' : 'ES256';
  const hash = signingChain.leafCurve === 'P-384' ? 'SHA-384' : 'SHA-256';
  const header = {
    alg,
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
      { name: 'ECDSA', hash },
      signingChain.leafPrivateKey,
      signingInput.slice().buffer as ArrayBuffer,
    ),
  );
  if (options.tamperSignature) {
    signature[signature.length - 1] ^= 0x01;
  }
  return `${encodedHeader}.${encodedPayload}.${base64Url(signature)}`;
}

function seedUser(userId: string) {
  sqlite
    .prepare('INSERT INTO user(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)')
    .run(userId, 'User', `${userId}@example.invalid`, NOW * 1000, NOW * 1000);
}

function seedSubscription(overrides: Partial<{
  originalTransactionId: string;
  userId: string;
  environment: 'Sandbox' | 'Production';
  productId: string;
  status: string;
  expiresAt: number | null;
  revokedAt: number | null;
  revocationReason: number | null;
  latestTransactionId: string;
  latestSignedDateMs: number;
  autoRenewStatus: number | null;
}> = {}) {
  sqlite
    .prepare(
      `INSERT INTO store_subscriptions (
         original_transaction_id, user_id, environment, product_id, status, expires_at,
         in_app_ownership_type, revoked_at, revocation_reason, latest_transaction_id,
         latest_signed_date_ms, auto_renew_status, owner_change_count, last_owner_changed_at,
         last_reconciled_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'PURCHASED', ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
    )
    .run(
      overrides.originalTransactionId ?? ORIG_TX_ID,
      overrides.userId ?? USER_UUID,
      overrides.environment ?? 'Sandbox',
      overrides.productId ?? PRODUCT_ID,
      overrides.status ?? 'active',
      overrides.expiresAt !== undefined ? overrides.expiresAt : NOW + 30 * 86400,
      overrides.revokedAt !== undefined ? overrides.revokedAt : null,
      overrides.revocationReason !== undefined ? overrides.revocationReason : null,
      overrides.latestTransactionId ?? '2000000000000001',
      overrides.latestSignedDateMs ?? (NOW - 100) * 1000,
      overrides.autoRenewStatus !== undefined ? overrides.autoRenewStatus : 1,
      NOW - 100,
      NOW - 100,
    );
}

function postNotification(body: unknown, method = 'POST') {
  return new Request('https://app.example.test/api/storekit/notifications', {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
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
    STOREKIT_ALLOWED_ENVIRONMENTS: 'Sandbox',
    STOREKIT_PRODUCT_PLANS_JSON: PRODUCT_PLANS_JSON,
  };
  seedUser(USER_UUID);
});

describe('POST /api/storekit/notifications', () => {
  it('returns 503 when StoreKit config is missing and rejects invalid HTTP requests or tampered JWS', async () => {
    const unconfigured = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: 'a.b.c' }),
      { ...env, STOREKIT_PRODUCT_PLANS_JSON: undefined },
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: 'not_configured' });

    const badMethod = await handleStoreKitNotificationRequest(
      new Request('https://app.example.test/api/storekit/notifications', { method: 'GET' }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(badMethod.status).toBe(405);

    const extraKey = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: 'a.b.c', extra: 1 }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(extraKey.status).toBe(400);

    const badJson = await handleStoreKitNotificationRequest(
      postNotification('{not-json'),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(badJson.status).toBe(400);

    const oversized = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: 'x'.repeat(70 * 1024) }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(oversized.status).toBe(413);

    const tamperedOuter = await signPayload(
      chain,
      {
        notificationType: 'TEST',
        notificationUUID: 'uuid-tampered',
        signedDate: (NOW - 5) * 1000,
        data: { environment: 'Sandbox', bundleId: 'jp.kakeimatch.ios' },
      },
      { tamperSignature: true },
    );
    const tamperedRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: tamperedOuter }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(tamperedRes.status).toBe(403);
    expect(await tamperedRes.json()).toEqual({ error: 'invalid_jws' });

    const futureOuter = await signPayload(chain, {
      notificationType: 'TEST',
      notificationUUID: 'uuid-future',
      signedDate: (NOW + 60) * 1000,
      data: { environment: 'Sandbox', bundleId: 'jp.kakeimatch.ios' },
    });
    const futureRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: futureOuter }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(futureRes.status).toBe(403);
    expect(await futureRes.json()).toEqual({ error: 'invalid_jws' });
  });

  it('inserts a new subscription on SUBSCRIBED via appAccountToken and stores timestamps in required units', async () => {
    const expiresSec = NOW + 30 * 86400;
    const notifSignedMs = (NOW - 10) * 1000;
    const txFixture = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        originalTransactionId: ORIG_TX_ID,
        transactionId: '2000000000000010',
        signedDate: (NOW - 15) * 1000,
        expiresDate: expiresSec * 1000,
        appAccountToken: USER_UUID,
      },
    });
    const signedRenewalInfo = await signPayload(chain, {
      originalTransactionId: ORIG_TX_ID,
      autoRenewStatus: 1,
      signedDate: (NOW - 12) * 1000,
    });
    const signedPayload = await signPayload(chain, {
      notificationType: 'SUBSCRIBED',
      subtype: 'INITIAL_BUY',
      notificationUUID: 'uuid-sub-1',
      version: '2.0',
      signedDate: notifSignedMs,
      data: {
        bundleId: 'jp.kakeimatch.ios',
        environment: 'Sandbox',
        signedTransactionInfo: txFixture.jws,
        signedRenewalInfo,
      },
    });

    const response = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, outcome: 'applied', status: 'active' });

    const sub = sqlite
      .prepare('SELECT user_id, status, expires_at, latest_signed_date_ms, auto_renew_status FROM store_subscriptions WHERE original_transaction_id = ?')
      .get(ORIG_TX_ID) as Record<string, unknown>;
    expect(sub).toEqual({
      user_id: USER_UUID,
      status: 'active',
      expires_at: expiresSec,
      latest_signed_date_ms: notifSignedMs,
      auto_renew_status: 1,
    });

    const notif = sqlite
      .prepare('SELECT notification_type, subtype, signed_date, outcome, received_at FROM store_notifications WHERE notification_uuid = ?')
      .get('uuid-sub-1') as Record<string, unknown>;
    expect(notif).toEqual({
      notification_type: 'SUBSCRIBED',
      subtype: 'INITIAL_BUY',
      signed_date: notifSignedMs,
      outcome: 'applied',
      received_at: NOW,
    });
  });

  it('transitions subscription statuses across renewal, grace period, billing retry, expiration, and renewal status change', async () => {
    seedSubscription({ status: 'active', latestSignedDateMs: (NOW - 500) * 1000 });

    // 1. DID_FAIL_TO_RENEW (GRACE_PERIOD) -> in_grace_period with gracePeriodExpiresDate
    const graceExpiresSec = NOW + 7 * 86400;
    const tx1 = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: { signedDate: (NOW - 450) * 1000, expiresDate: (NOW - 60) * 1000 },
    });
    const renewal1 = await signPayload(chain, {
      originalTransactionId: ORIG_TX_ID,
      autoRenewStatus: 1,
      gracePeriodExpiresDate: graceExpiresSec * 1000,
      signedDate: (NOW - 400) * 1000,
    });
    const payload1 = await signPayload(chain, {
      notificationType: 'DID_FAIL_TO_RENEW',
      subtype: 'GRACE_PERIOD',
      notificationUUID: 'uuid-grace',
      signedDate: (NOW - 350) * 1000,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: tx1.jws, signedRenewalInfo: renewal1 },
    });
    const res1 = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: payload1 }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(res1.status).toBe(200);
    expect(sqlite.prepare('SELECT status, expires_at FROM store_subscriptions WHERE original_transaction_id = ?').get(ORIG_TX_ID)).toEqual({
      status: 'in_grace_period',
      expires_at: graceExpiresSec,
    });

    // 2. GRACE_PERIOD_EXPIRED with isInBillingRetryPeriod: true -> in_billing_retry
    const renewal2 = await signPayload(chain, {
      originalTransactionId: ORIG_TX_ID,
      autoRenewStatus: 1,
      isInBillingRetryPeriod: true,
      signedDate: (NOW - 300) * 1000,
    });
    const payload2 = await signPayload(chain, {
      notificationType: 'GRACE_PERIOD_EXPIRED',
      notificationUUID: 'uuid-grace-exp',
      signedDate: (NOW - 280) * 1000,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: tx1.jws, signedRenewalInfo: renewal2 },
    });
    await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: payload2 }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(sqlite.prepare('SELECT status FROM store_subscriptions WHERE original_transaction_id = ?').get(ORIG_TX_ID)).toEqual({
      status: 'in_billing_retry',
    });

    // 3. DID_RENEW -> active with extended expires_at
    const renewedExpiresSec = NOW + 60 * 86400;
    const tx3 = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        transactionId: '2000000000000002',
        signedDate: (NOW - 200) * 1000,
        expiresDate: renewedExpiresSec * 1000,
      },
    });
    const payload3 = await signPayload(chain, {
      notificationType: 'DID_RENEW',
      notificationUUID: 'uuid-renew',
      signedDate: (NOW - 190) * 1000,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: tx3.jws },
    });
    await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: payload3 }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(sqlite.prepare('SELECT status, expires_at, latest_transaction_id FROM store_subscriptions WHERE original_transaction_id = ?').get(ORIG_TX_ID)).toEqual({
      status: 'active',
      expires_at: renewedExpiresSec,
      latest_transaction_id: '2000000000000002',
    });

    // 4. DID_CHANGE_RENEWAL_STATUS (AUTO_RENEW_DISABLED) -> auto_renew_status = 0, status stays active
    const payload4 = await signPayload(chain, {
      notificationType: 'DID_CHANGE_RENEWAL_STATUS',
      subtype: 'AUTO_RENEW_DISABLED',
      notificationUUID: 'uuid-auto-off',
      signedDate: (NOW - 100) * 1000,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: tx3.jws },
    });
    await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: payload4 }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(sqlite.prepare('SELECT status, auto_renew_status FROM store_subscriptions WHERE original_transaction_id = ?').get(ORIG_TX_ID)).toEqual({
      status: 'active',
      auto_renew_status: 0,
    });

    // 5. EXPIRED -> expired
    const payload5 = await signPayload(chain, {
      notificationType: 'EXPIRED',
      subtype: 'VOLUNTARY',
      notificationUUID: 'uuid-expired',
      signedDate: (NOW - 50) * 1000,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: tx3.jws },
    });
    await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: payload5 }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(sqlite.prepare('SELECT status FROM store_subscriptions WHERE original_transaction_id = ?').get(ORIG_TX_ID)).toEqual({
      status: 'expired',
    });
  });

  it('is idempotent on duplicate notificationUUID and ignores out-of-order stale notifications', async () => {
    seedSubscription({ status: 'active', latestSignedDateMs: (NOW - 100) * 1000 });

    const txNew = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        transactionId: '2000000000000099',
        signedDate: (NOW - 20) * 1000,
        expiresDate: (NOW + 60 * 86400) * 1000,
      },
    });
    const newNotif = await signPayload(chain, {
      notificationType: 'DID_RENEW',
      notificationUUID: 'uuid-dup-1',
      signedDate: (NOW - 15) * 1000,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: txNew.jws },
    });

    const first = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: newNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(await first.json()).toEqual({ received: true, outcome: 'applied', status: 'active' });

    // Re-send exact same notificationUUID: must be idempotent.
    const duplicate = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: newNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ received: true, duplicate: true, outcome: 'applied' });

    // Older notification (signedDate < latest_signed_date_ms) must NOT downgrade state.
    const txOld = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        signedDate: (NOW - 60) * 1000,
        expiresDate: (NOW - 30) * 1000,
      },
    });
    const staleNotif = await signPayload(chain, {
      notificationType: 'EXPIRED',
      notificationUUID: 'uuid-stale-1',
      signedDate: (NOW - 50) * 1000,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: txOld.jws },
    });
    const staleRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: staleNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(staleRes.status).toBe(200);
    expect(await staleRes.json()).toEqual({ received: true, outcome: 'ignored_stale' });
    expect(sqlite.prepare('SELECT status, latest_transaction_id FROM store_subscriptions WHERE original_transaction_id = ?').get(ORIG_TX_ID)).toEqual({
      status: 'active',
      latest_transaction_id: '2000000000000099',
    });
  });

  it('marks subscription revoked on REFUND and never reverts revoked status on subsequent newer notifications', async () => {
    seedSubscription({ status: 'active', latestSignedDateMs: (NOW - 200) * 1000 });

    const revokedSec = NOW - 50;
    const txRefund = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        signedDate: (NOW - 50) * 1000,
        revocationDate: revokedSec * 1000,
        revocationReason: 1,
      },
    });
    const refundNotif = await signPayload(chain, {
      notificationType: 'REFUND',
      notificationUUID: 'uuid-refund-1',
      signedDate: (NOW - 40) * 1000,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: txRefund.jws },
    });
    const refundRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: refundNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(refundRes.status).toBe(200);
    expect(await refundRes.json()).toEqual({ received: true, outcome: 'applied', status: 'revoked' });

    // Non-REFUND_REVERSED notifications (e.g. DID_RENEW, duplicate REFUND) after revocation stay ignored_stale.
    const txAfter = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        transactionId: '2000000000000777',
        signedDate: (NOW - 10) * 1000,
        expiresDate: (NOW + 90 * 86400) * 1000,
      },
    });
    const afterNotif = await signPayload(chain, {
      notificationType: 'DID_RENEW',
      notificationUUID: 'uuid-after-refund',
      signedDate: (NOW - 5) * 1000,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: txAfter.jws },
    });
    const afterRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: afterNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(afterRes.status).toBe(200);
    expect(await afterRes.json()).toEqual({ received: true, outcome: 'ignored_stale' });

    expect(
      sqlite
        .prepare('SELECT status, revoked_at, revocation_reason FROM store_subscriptions WHERE original_transaction_id = ?')
        .get(ORIG_TX_ID),
    ).toEqual({
      status: 'revoked',
      revoked_at: revokedSec,
      revocation_reason: 1,
    });
  });

  it('restores a revoked subscription on REFUND_REVERSED while enforcing signedDate ordering and idempotency', async () => {
    seedSubscription({ status: 'active', latestSignedDateMs: (NOW - 300) * 1000 });

    const revokedSec = NOW - 100;
    const txRefund = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        signedDate: (NOW - 100) * 1000,
        revocationDate: revokedSec * 1000,
        revocationReason: 1,
      },
    });
    const refundNotif = await signPayload(chain, {
      notificationType: 'REFUND',
      notificationUUID: 'uuid-rr-refund',
      signedDate: (NOW - 90) * 1000,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: txRefund.jws },
    });
    const refundRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: refundNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(await refundRes.json()).toEqual({ received: true, outcome: 'applied', status: 'revoked' });

    // Stale REFUND_REVERSED (older signedDate than the refund) must be ignored_stale.
    const txStaleReversed = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        signedDate: (NOW - 150) * 1000,
        expiresDate: (NOW + 30 * 86400) * 1000,
      },
    });
    const staleReversedNotif = await signPayload(chain, {
      notificationType: 'REFUND_REVERSED',
      notificationUUID: 'uuid-rr-stale',
      signedDate: (NOW - 120) * 1000,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: txStaleReversed.jws },
    });
    const staleRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: staleReversedNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(await staleRes.json()).toEqual({ received: true, outcome: 'ignored_stale' });

    // Newer REFUND_REVERSED restores the subscription to active and clears revocation fields.
    const restoredExpiresSec = NOW + 30 * 86400;
    const reversedSignedMs = (NOW - 20) * 1000;
    const txReversed = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        signedDate: (NOW - 30) * 1000,
        expiresDate: restoredExpiresSec * 1000,
      },
    });
    const reversedNotif = await signPayload(chain, {
      notificationType: 'REFUND_REVERSED',
      notificationUUID: 'uuid-rr-apply',
      signedDate: reversedSignedMs,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: txReversed.jws },
    });
    const reversedRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: reversedNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(reversedRes.status).toBe(200);
    expect(await reversedRes.json()).toEqual({ received: true, outcome: 'applied', status: 'active' });

    expect(
      sqlite
        .prepare('SELECT status, expires_at, revoked_at, revocation_reason, latest_signed_date_ms FROM store_subscriptions WHERE original_transaction_id = ?')
        .get(ORIG_TX_ID),
    ).toEqual({
      status: 'active',
      expires_at: restoredExpiresSec,
      revoked_at: null,
      revocation_reason: null,
      latest_signed_date_ms: reversedSignedMs,
    });

    // Duplicate REFUND_REVERSED with the same notificationUUID is idempotent.
    const dupRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: reversedNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(dupRes.status).toBe(200);
    expect(await dupRes.json()).toEqual({ received: true, duplicate: true, outcome: 'applied' });
  });

  it('does not revoke a newer renewed subscription when a REFUND arrives for an older billing-period transaction', async () => {
    const currentExpiresSec = NOW + 29 * 86400;
    seedSubscription({
      originalTransactionId: ORIG_TX_ID,
      status: 'active',
      expiresAt: currentExpiresSec,
      latestTransactionId: '2000000000000002',
      latestSignedDateMs: (NOW - 86400) * 1000,
    });

    // Refund for an older period transaction (different transactionId, earlier expiresDate),
    // even though Apple signed the refund notification today (newer signedDate).
    const priorExpiresSec = NOW - 86400;
    const txOldPeriodRefund = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        originalTransactionId: ORIG_TX_ID,
        transactionId: '2000000000000001',
        signedDate: (NOW - 10) * 1000,
        expiresDate: priorExpiresSec * 1000,
        revocationDate: (NOW - 10) * 1000,
        revocationReason: 1,
      },
    });
    const oldPeriodRefundNotif = await signPayload(chain, {
      notificationType: 'REFUND',
      notificationUUID: 'uuid-old-period-refund',
      signedDate: (NOW - 5) * 1000,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: txOldPeriodRefund.jws },
    });

    const response = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: oldPeriodRefundNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, outcome: 'ignored_stale' });

    expect(
      sqlite
        .prepare('SELECT status, expires_at, revoked_at, latest_transaction_id FROM store_subscriptions WHERE original_transaction_id = ?')
        .get(ORIG_TX_ID),
    ).toEqual({
      status: 'active',
      expires_at: currentExpiresSec,
      revoked_at: null,
      latest_transaction_id: '2000000000000002',
    });
  });

  it('always applies REFUND and REVOKE even when signedDate is older than latest_signed_date_ms', async () => {
    const advancedSignedDateMs = (NOW - 10) * 1000;
    seedSubscription({
      originalTransactionId: ORIG_TX_ID,
      status: 'active',
      latestSignedDateMs: advancedSignedDateMs,
    });
    seedSubscription({
      originalTransactionId: '1000000000000002',
      status: 'active',
      latestSignedDateMs: advancedSignedDateMs,
    });

    // Delayed REFUND older than latest_signed_date_ms (e.g. client POST advanced latest_signed_date_ms)
    const refundRevokedSec = NOW - 120;
    const txRefund = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        originalTransactionId: ORIG_TX_ID,
        signedDate: (NOW - 120) * 1000,
        revocationDate: refundRevokedSec * 1000,
        revocationReason: 1,
      },
    });
    const delayedRefund = await signPayload(chain, {
      notificationType: 'REFUND',
      notificationUUID: 'uuid-delayed-refund',
      signedDate: (NOW - 100) * 1000,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: txRefund.jws },
    });
    const refundRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: delayedRefund }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(refundRes.status).toBe(200);
    expect(await refundRes.json()).toEqual({ received: true, outcome: 'applied', status: 'revoked' });
    expect(
      sqlite
        .prepare('SELECT status, revoked_at, revocation_reason, latest_signed_date_ms FROM store_subscriptions WHERE original_transaction_id = ?')
        .get(ORIG_TX_ID),
    ).toEqual({
      status: 'revoked',
      revoked_at: refundRevokedSec,
      revocation_reason: 1,
      latest_signed_date_ms: advancedSignedDateMs,
    });

    // Delayed REVOKE older than latest_signed_date_ms must also apply immediately
    const revokeNotifSignedMs = (NOW - 80) * 1000;
    const txRevoke = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        originalTransactionId: '1000000000000002',
        signedDate: (NOW - 90) * 1000,
      },
    });
    const delayedRevoke = await signPayload(chain, {
      notificationType: 'REVOKE',
      notificationUUID: 'uuid-delayed-revoke',
      signedDate: revokeNotifSignedMs,
      data: { bundleId: 'jp.kakeimatch.ios', environment: 'Sandbox', signedTransactionInfo: txRevoke.jws },
    });
    const revokeRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: delayedRevoke }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(revokeRes.status).toBe(200);
    expect(await revokeRes.json()).toEqual({ received: true, outcome: 'applied', status: 'revoked' });
    expect(
      sqlite
        .prepare('SELECT status, revoked_at, latest_signed_date_ms FROM store_subscriptions WHERE original_transaction_id = ?')
        .get('1000000000000002'),
    ).toEqual({
      status: 'revoked',
      revoked_at: Math.floor(revokeNotifSignedMs / 1000),
      latest_signed_date_ms: advancedSignedDateMs,
    });
  });

  it('records ignored_env, ignored_non_tx, and ignored_unknown_user outcomes accurately', async () => {
    // 1. Disallowed environment (Production) -> ignored_env
    const prodNotif = await signPayload(chain, {
      notificationType: 'TEST',
      notificationUUID: 'uuid-prod-env',
      signedDate: (NOW - 10) * 1000,
      data: { environment: 'Production', bundleId: 'jp.kakeimatch.ios' },
    });
    const prodRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: prodNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(await prodRes.json()).toEqual({ received: true, outcome: 'ignored_env' });

    // 2. TEST notification -> ignored_non_tx
    const testNotif = await signPayload(chain, {
      notificationType: 'TEST',
      notificationUUID: 'uuid-test',
      signedDate: (NOW - 10) * 1000,
      data: { environment: 'Sandbox', bundleId: 'jp.kakeimatch.ios' },
    });
    const testRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: testNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(await testRes.json()).toEqual({ received: true, outcome: 'ignored_non_tx' });

    // 3. FAMILY_SHARED -> ignored_non_tx
    const familyTx = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: { inAppOwnershipType: 'FAMILY_SHARED' },
    });
    const familyNotif = await signPayload(chain, {
      notificationType: 'SUBSCRIBED',
      notificationUUID: 'uuid-family',
      signedDate: (NOW - 10) * 1000,
      data: { environment: 'Sandbox', bundleId: 'jp.kakeimatch.ios', signedTransactionInfo: familyTx.jws },
    });
    const familyRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: familyNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(await familyRes.json()).toEqual({ received: true, outcome: 'ignored_non_tx' });

    // 4. Unregistered product_id -> ignored_non_tx
    const unknownProductTx = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: { productId: 'jp.kakeimatch.unknown' },
    });
    const unknownProductNotif = await signPayload(chain, {
      notificationType: 'SUBSCRIBED',
      notificationUUID: 'uuid-unknown-prod',
      signedDate: (NOW - 10) * 1000,
      data: { environment: 'Sandbox', bundleId: 'jp.kakeimatch.ios', signedTransactionInfo: unknownProductTx.jws },
    });
    const unknownProductRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: unknownProductNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(await unknownProductRes.json()).toEqual({ received: true, outcome: 'ignored_non_tx' });

    // 5. Unknown user (no existing subscription and no matching user for appAccountToken) -> ignored_unknown_user
    const unknownUserTx = await buildStoreKitJwsFixture({
      chain,
      payloadOverrides: {
        originalTransactionId: '9999999999999999',
        appAccountToken: '22222222-2222-4222-8222-222222222222',
      },
    });
    const unknownUserNotif = await signPayload(chain, {
      notificationType: 'SUBSCRIBED',
      notificationUUID: 'uuid-unknown-user',
      signedDate: (NOW - 10) * 1000,
      data: { environment: 'Sandbox', bundleId: 'jp.kakeimatch.ios', signedTransactionInfo: unknownUserTx.jws },
    });
    const unknownUserRes = await handleStoreKitNotificationRequest(
      postNotification({ signedPayload: unknownUserNotif }),
      env,
      { nowSeconds: () => NOW, storeKitTestTrustAnchor: chain.rootDER },
    );
    expect(await unknownUserRes.json()).toEqual({ received: true, outcome: 'ignored_unknown_user' });
  });
});
