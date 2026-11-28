import type { AccountEnv } from './account-db';
import { parseStoreKitConfig, type StoreKitEnv } from './entitlements';
import { readRequestBytes } from './request-body';
import {
  verifyStoreKitJws,
  verifyStoreKitTransactionJws,
  type StoreKitEnvironment,
  type VerifiedStoreKitTransaction,
} from './storekit-jws';

type Db = AccountEnv['ACCOUNT_DB'];

export type StoreKitNotificationsEnv = AccountEnv & StoreKitEnv;

export interface StoreKitNotificationsOptions {
  nowSeconds?: () => number;
  /** Trust-anchor injection is for synthetic unit tests only. No HTTP/binding can supply it. */
  storeKitTestTrustAnchor?: Uint8Array;
}

type SubscriptionStatus = 'active' | 'in_grace_period' | 'in_billing_retry' | 'expired' | 'revoked';
type NotificationOutcome =
  | 'applied'
  | 'ignored_stale'
  | 'ignored_unknown_user'
  | 'ignored_non_tx'
  | 'ignored_env';

type ExistingSubscriptionRow = {
  original_transaction_id: string;
  user_id: string;
  environment: StoreKitEnvironment;
  product_id: string;
  status: SubscriptionStatus;
  expires_at: number | null;
  revoked_at: number | null;
  revocation_reason: number | null;
  latest_transaction_id: string;
  latest_signed_date_ms: number;
  auto_renew_status: number | null;
};

interface VerifiedRenewalInfo {
  originalTransactionId: string | null;
  signedDateMs: number | null;
  autoRenewStatus: 0 | 1 | null;
  gracePeriodExpiresAt: number | null;
  isInBillingRetryPeriod: boolean | null;
}

const EXPECTED_BUNDLE_ID = 'jp.kakeimatch.ios';
const REVOCATION_NOTIFICATION_TYPES = new Set(['REFUND', 'REVOKE']);

function isRevocationNotification(notificationType: string, tx: VerifiedStoreKitTransaction): boolean {
  return REVOCATION_NOTIFICATION_TYPES.has(notificationType) || tx.revokedAt !== null;
}

function isPriorPeriodTransaction(existing: ExistingSubscriptionRow, tx: VerifiedStoreKitTransaction): boolean {
  return (
    tx.transactionId !== existing.latest_transaction_id &&
    existing.expires_at !== null &&
    tx.expiresAt !== null &&
    tx.expiresAt < existing.expires_at
  );
}
const MAX_NOTIFICATION_BODY_BYTES = 64 * 1024;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalNonEmptyString(value: unknown, maxLength = 128): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error('invalid_payload');
  }
  return value;
}

function requireNonEmptyString(value: unknown, maxLength = 128): string {
  const parsed = optionalNonEmptyString(value, maxLength);
  if (parsed === null) throw new Error('invalid_payload');
  return parsed;
}

function requireTimestampMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid_payload');
  }
  return value;
}

function optionalTimestampMs(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return requireTimestampMs(value);
}

function parseRenewalInfoPayload(payload: Record<string, unknown>, nowMs: number): VerifiedRenewalInfo {
  const signedDateMs = optionalTimestampMs(payload.signedDate);
  if (signedDateMs !== null && signedDateMs > nowMs) {
    throw new Error('future_signed_date');
  }
  let autoRenewStatus: 0 | 1 | null = null;
  if (payload.autoRenewStatus !== undefined && payload.autoRenewStatus !== null) {
    if (payload.autoRenewStatus !== 0 && payload.autoRenewStatus !== 1) {
      throw new Error('invalid_payload');
    }
    autoRenewStatus = payload.autoRenewStatus;
  }
  const gracePeriodExpiresDateMs = optionalTimestampMs(payload.gracePeriodExpiresDate);
  let isInBillingRetryPeriod: boolean | null = null;
  if (payload.isInBillingRetryPeriod !== undefined && payload.isInBillingRetryPeriod !== null) {
    if (typeof payload.isInBillingRetryPeriod !== 'boolean') {
      throw new Error('invalid_payload');
    }
    isInBillingRetryPeriod = payload.isInBillingRetryPeriod;
  }
  return {
    originalTransactionId: optionalNonEmptyString(payload.originalTransactionId),
    signedDateMs,
    autoRenewStatus,
    gracePeriodExpiresAt: gracePeriodExpiresDateMs === null ? null : Math.floor(gracePeriodExpiresDateMs / 1000),
    isInBillingRetryPeriod,
  };
}

interface TransitionResult {
  handled: boolean;
  status: SubscriptionStatus;
  expiresAt: number | null;
  revokedAt: number | null;
  revocationReason: number | null;
  autoRenewStatus: number | null;
}

function resolveNotificationTransition(
  notificationType: string,
  subtype: string | null,
  tx: VerifiedStoreKitTransaction,
  renewal: VerifiedRenewalInfo | null,
  existing: ExistingSubscriptionRow | null,
  notificationSignedDateMs: number,
  now: number,
): TransitionResult {
  const autoRenewFromSubtype =
    notificationType === 'DID_CHANGE_RENEWAL_STATUS'
      ? subtype === 'AUTO_RENEW_ENABLED'
        ? 1
        : subtype === 'AUTO_RENEW_DISABLED'
          ? 0
          : null
      : null;
  const nextAutoRenewStatus = renewal?.autoRenewStatus ?? autoRenewFromSubtype ?? existing?.auto_renew_status ?? null;

  if (isRevocationNotification(notificationType, tx)) {
    return {
      handled: true,
      status: 'revoked',
      expiresAt: tx.expiresAt,
      revokedAt: tx.revokedAt ?? Math.floor(notificationSignedDateMs / 1000),
      revocationReason: tx.revocationReason,
      autoRenewStatus: nextAutoRenewStatus,
    };
  }

  switch (notificationType) {
    case 'SUBSCRIBED':
    case 'DID_RENEW':
    case 'OFFER_REDEEMED':
    case 'RENEWAL_EXTENDED':
    case 'RENEWAL_EXTENSION':
    case 'REFUND_REVERSED': {
      const status: SubscriptionStatus = tx.expiresAt !== null && tx.expiresAt <= now ? 'expired' : 'active';
      return {
        handled: true,
        status,
        expiresAt: tx.expiresAt,
        revokedAt: null,
        revocationReason: null,
        autoRenewStatus: nextAutoRenewStatus,
      };
    }
    case 'DID_FAIL_TO_RENEW': {
      if (subtype === 'GRACE_PERIOD') {
        return {
          handled: true,
          status: 'in_grace_period',
          expiresAt: renewal?.gracePeriodExpiresAt ?? tx.expiresAt,
          revokedAt: null,
          revocationReason: null,
          autoRenewStatus: nextAutoRenewStatus,
        };
      }
      return {
        handled: true,
        status: 'in_billing_retry',
        expiresAt: tx.expiresAt,
        revokedAt: null,
        revocationReason: null,
        autoRenewStatus: nextAutoRenewStatus,
      };
    }
    case 'GRACE_PERIOD_EXPIRED': {
      const status: SubscriptionStatus = renewal?.isInBillingRetryPeriod ? 'in_billing_retry' : 'expired';
      return {
        handled: true,
        status,
        expiresAt: tx.expiresAt,
        revokedAt: null,
        revocationReason: null,
        autoRenewStatus: nextAutoRenewStatus,
      };
    }
    case 'EXPIRED': {
      return {
        handled: true,
        status: 'expired',
        expiresAt: tx.expiresAt,
        revokedAt: null,
        revocationReason: null,
        autoRenewStatus: nextAutoRenewStatus,
      };
    }
    case 'DID_CHANGE_RENEWAL_STATUS':
    case 'DID_CHANGE_RENEWAL_PREF':
    case 'PRICE_INCREASE': {
      const fallbackStatus: SubscriptionStatus = tx.expiresAt !== null && tx.expiresAt <= now ? 'expired' : 'active';
      return {
        handled: true,
        status: existing?.status ?? fallbackStatus,
        expiresAt: tx.expiresAt ?? existing?.expires_at ?? null,
        revokedAt: null,
        revocationReason: null,
        autoRenewStatus: nextAutoRenewStatus,
      };
    }
    default:
      return {
        handled: false,
        status: existing?.status ?? 'expired',
        expiresAt: existing?.expires_at ?? tx.expiresAt,
        revokedAt: existing?.revoked_at ?? null,
        revocationReason: existing?.revocation_reason ?? null,
        autoRenewStatus: nextAutoRenewStatus,
      };
  }
}

async function recordNotification(
  db: Db,
  params: {
    notificationUuid: string;
    notificationType: string;
    subtype: string | null;
    environment: StoreKitEnvironment;
    originalTransactionId: string | null;
    signedDateMs: number;
    outcome: NotificationOutcome;
    receivedAt: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO store_notifications (
         notification_uuid, notification_type, subtype, environment,
         original_transaction_id, signed_date, outcome, received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(notification_uuid) DO NOTHING`,
    )
    .bind(
      params.notificationUuid,
      params.notificationType,
      params.subtype,
      params.environment,
      params.originalTransactionId,
      params.signedDateMs,
      params.outcome,
      params.receivedAt,
    )
    .run();
  if (!result.success) throw new Error('storekit_notification_write_failed');
  return (result.meta?.changes ?? 0) === 1;
}

/**
 * Handles POST /api/storekit/notifications (App Store Server Notifications V2).
 *
 * Invariants:
 * - Verifies outer signedPayload (and inner signedTransactionInfo / signedRenewalInfo) via PR #487's JWS verifier.
 * - Idempotent by notificationUUID via store_notifications.
 * - Enforces signedDate ordering (older notifications never overwrite newer state).
 * - Once a subscription is revoked, notifications never revert it (recorded as ignored_stale).
 * - Timestamps: expires_at/revoked_at/received_at in UNIX seconds; latest_signed_date_ms and store_notifications.signed_date in UNIX ms.
 */
export async function handleStoreKitNotificationRequest(
  request: Request,
  env: StoreKitNotificationsEnv,
  options: StoreKitNotificationsOptions = {},
): Promise<Response> {
  if (request.method !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }

  const config = parseStoreKitConfig(env);
  if (!config) {
    return json(503, { error: 'not_configured' });
  }

  const bodyBytes = await readRequestBytes(request, MAX_NOTIFICATION_BODY_BYTES);
  if (bodyBytes === null) {
    return json(413, { error: 'payload_too_large' });
  }

  let body: unknown;
  try {
    body = JSON.parse(utf8Decoder.decode(bodyBytes));
  } catch {
    return json(400, { error: 'invalid_request' });
  }
  if (!isPlainObject(body)) {
    return json(400, { error: 'invalid_request' });
  }
  const bodyKeys = Object.keys(body);
  if (bodyKeys.length !== 1 || bodyKeys[0] !== 'signedPayload' || typeof body.signedPayload !== 'string' || body.signedPayload.length === 0) {
    return json(400, { error: 'invalid_request' });
  }

  const now = options.nowSeconds ? options.nowSeconds() : Math.floor(Date.now() / 1000);
  const nowDate = new Date(now * 1000);
  const nowMs = now * 1000;

  let outerPayload: Record<string, unknown>;
  try {
    outerPayload = await verifyStoreKitJws(body.signedPayload, {
      now: nowDate,
      testTrustAnchor: options.storeKitTestTrustAnchor,
    });
  } catch {
    return json(403, { error: 'invalid_jws' });
  }

  let notificationUuid: string;
  let notificationType: string;
  let subtype: string | null;
  let signedDateMs: number;
  let data: Record<string, unknown>;
  let environment: StoreKitEnvironment;

  try {
    notificationUuid = requireNonEmptyString(outerPayload.notificationUUID);
    notificationType = requireNonEmptyString(outerPayload.notificationType, 64);
    subtype = optionalNonEmptyString(outerPayload.subtype, 64);
    signedDateMs = requireTimestampMs(outerPayload.signedDate);
    if (signedDateMs > nowMs) {
      return json(403, { error: 'invalid_jws' });
    }
    if (!isPlainObject(outerPayload.data)) {
      throw new Error('invalid_payload');
    }
    data = outerPayload.data;
    if (data.environment !== 'Sandbox' && data.environment !== 'Production') {
      throw new Error('invalid_payload');
    }
    environment = data.environment;
  } catch {
    return json(400, { error: 'invalid_payload' });
  }

  const db = env.ACCOUNT_DB;

  // Idempotency check by notificationUUID before any state mutation.
  const existingNotification = await db
    .prepare('SELECT outcome FROM store_notifications WHERE notification_uuid = ?')
    .bind(notificationUuid)
    .first<{ outcome: NotificationOutcome }>();
  if (existingNotification) {
    return json(200, { received: true, duplicate: true, outcome: existingNotification.outcome });
  }

  if (!config.allowedEnvironments.includes(environment)) {
    await recordNotification(db, {
      notificationUuid,
      notificationType,
      subtype,
      environment,
      originalTransactionId: null,
      signedDateMs,
      outcome: 'ignored_env',
      receivedAt: now,
    });
    return json(200, { received: true, outcome: 'ignored_env' });
  }

  const dataBundleId = data.bundleId;
  if (dataBundleId !== undefined && dataBundleId !== null) {
    if (typeof dataBundleId !== 'string' || dataBundleId !== EXPECTED_BUNDLE_ID) {
      await recordNotification(db, {
        notificationUuid,
        notificationType,
        subtype,
        environment,
        originalTransactionId: null,
        signedDateMs,
        outcome: 'ignored_non_tx',
        receivedAt: now,
      });
      return json(200, { received: true, outcome: 'ignored_non_tx' });
    }
  }

  if (notificationType === 'TEST' || typeof data.signedTransactionInfo !== 'string' || data.signedTransactionInfo.length === 0) {
    await recordNotification(db, {
      notificationUuid,
      notificationType,
      subtype,
      environment,
      originalTransactionId: null,
      signedDateMs,
      outcome: 'ignored_non_tx',
      receivedAt: now,
    });
    return json(200, { received: true, outcome: 'ignored_non_tx' });
  }

  let tx: VerifiedStoreKitTransaction;
  try {
    tx = await verifyStoreKitTransactionJws(data.signedTransactionInfo, {
      now: nowDate,
      expectedBundleId: EXPECTED_BUNDLE_ID,
      testTrustAnchor: options.storeKitTestTrustAnchor,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'unsupported_transaction_type') {
      await recordNotification(db, {
        notificationUuid,
        notificationType,
        subtype,
        environment,
        originalTransactionId: null,
        signedDateMs,
        outcome: 'ignored_non_tx',
        receivedAt: now,
      });
      return json(200, { received: true, outcome: 'ignored_non_tx' });
    }
    return json(403, { error: 'invalid_jws' });
  }

  if (tx.environment !== environment) {
    return json(403, { error: 'invalid_jws' });
  }

  let renewal: VerifiedRenewalInfo | null = null;
  if (data.signedRenewalInfo !== undefined && data.signedRenewalInfo !== null) {
    if (typeof data.signedRenewalInfo !== 'string' || data.signedRenewalInfo.length === 0) {
      return json(400, { error: 'invalid_payload' });
    }
    try {
      const renewalPayload = await verifyStoreKitJws(data.signedRenewalInfo, {
        now: nowDate,
        testTrustAnchor: options.storeKitTestTrustAnchor,
      });
      renewal = parseRenewalInfoPayload(renewalPayload, nowMs);
    } catch {
      return json(403, { error: 'invalid_jws' });
    }
    if (renewal.originalTransactionId !== null && renewal.originalTransactionId !== tx.originalTransactionId) {
      return json(403, { error: 'invalid_jws' });
    }
  }

  if (
    tx.inAppOwnershipType !== 'PURCHASED' ||
    !Object.prototype.hasOwnProperty.call(config.productPlans, tx.productId)
  ) {
    await recordNotification(db, {
      notificationUuid,
      notificationType,
      subtype,
      environment,
      originalTransactionId: tx.originalTransactionId,
      signedDateMs,
      outcome: 'ignored_non_tx',
      receivedAt: now,
    });
    return json(200, { received: true, outcome: 'ignored_non_tx' });
  }

  const existing = await db
    .prepare(
      `SELECT original_transaction_id, user_id, environment, product_id, status, expires_at,
              revoked_at, revocation_reason, latest_transaction_id, latest_signed_date_ms,
              auto_renew_status
       FROM store_subscriptions
       WHERE original_transaction_id = ?`,
    )
    .bind(tx.originalTransactionId)
    .first<ExistingSubscriptionRow>();

  const eventSignedDateMs = Math.max(signedDateMs, tx.signedDateMs, renewal?.signedDateMs ?? 0);

  const isRefundReversed = notificationType === 'REFUND_REVERSED';

  // Invariant: once revoked, notifications never revert or mutate the subscription,
  // EXCEPT REFUND_REVERSED (Apple reversed the refund), which restores the subscription
  // according to the verified signedTransactionInfo (subject to signedDate ordering).
  if (existing && !isRefundReversed && (existing.status === 'revoked' || existing.revoked_at !== null)) {
    await recordNotification(db, {
      notificationUuid,
      notificationType,
      subtype,
      environment,
      originalTransactionId: tx.originalTransactionId,
      signedDateMs,
      outcome: 'ignored_stale',
      receivedAt: now,
    });
    return json(200, { received: true, outcome: 'ignored_stale' });
  }

  const isRevocation = isRevocationNotification(notificationType, tx);

  // Guard: a revocation (or refund reversal) for an older billing-period transaction must not
  // overwrite or revoke a newer active renewal on the same originalTransactionId.
  if (existing && (isRevocation || isRefundReversed) && isPriorPeriodTransaction(existing, tx)) {
    await recordNotification(db, {
      notificationUuid,
      notificationType,
      subtype,
      environment,
      originalTransactionId: tx.originalTransactionId,
      signedDateMs,
      outcome: 'ignored_stale',
      receivedAt: now,
    });
    return json(200, { received: true, outcome: 'ignored_stale' });
  }

  // Invariant: enforce signedDate ordering so older notifications never overwrite newer state,
  // EXCEPT revocation notifications (REFUND, REVOKE, or tx.revokedAt !== null) for the current
  // (or newer) period, which always apply even if a client POST previously advanced latest_signed_date_ms.
  if (existing && !isRevocation && eventSignedDateMs < existing.latest_signed_date_ms) {
    await recordNotification(db, {
      notificationUuid,
      notificationType,
      subtype,
      environment,
      originalTransactionId: tx.originalTransactionId,
      signedDateMs,
      outcome: 'ignored_stale',
      receivedAt: now,
    });
    return json(200, { received: true, outcome: 'ignored_stale' });
  }

  const transition = resolveNotificationTransition(
    notificationType,
    subtype,
    tx,
    renewal,
    existing,
    signedDateMs,
    now,
  );
  if (!transition.handled) {
    await recordNotification(db, {
      notificationUuid,
      notificationType,
      subtype,
      environment,
      originalTransactionId: tx.originalTransactionId,
      signedDateMs,
      outcome: 'ignored_non_tx',
      receivedAt: now,
    });
    return json(200, { received: true, outcome: 'ignored_non_tx' });
  }

  if (existing) {
    const updated = isRevocation
      ? await db
          .prepare(
            `UPDATE store_subscriptions
             SET environment = ?,
                 product_id = ?,
                 status = ?,
                 expires_at = ?,
                 revoked_at = ?,
                 revocation_reason = ?,
                 latest_transaction_id = ?,
                 latest_signed_date_ms = MAX(latest_signed_date_ms, ?),
                 auto_renew_status = ?,
                 updated_at = ?
             WHERE original_transaction_id = ?
               AND revoked_at IS NULL
               AND status != 'revoked'
               AND (
                 latest_transaction_id = ?
                 OR expires_at IS NULL
                 OR ? IS NULL
                 OR expires_at <= ?
               )`,
          )
          .bind(
            tx.environment,
            tx.productId,
            transition.status,
            transition.expiresAt,
            transition.revokedAt,
            transition.revocationReason,
            tx.transactionId,
            eventSignedDateMs,
            transition.autoRenewStatus,
            now,
            tx.originalTransactionId,
            tx.transactionId,
            tx.expiresAt,
            tx.expiresAt,
          )
          .run()
      : isRefundReversed
        ? await db
            .prepare(
              `UPDATE store_subscriptions
               SET environment = ?,
                   product_id = ?,
                   status = ?,
                   expires_at = ?,
                   revoked_at = ?,
                   revocation_reason = ?,
                   latest_transaction_id = ?,
                   latest_signed_date_ms = ?,
                   auto_renew_status = ?,
                   updated_at = ?
               WHERE original_transaction_id = ?
                 AND latest_signed_date_ms <= ?`,
            )
            .bind(
              tx.environment,
              tx.productId,
              transition.status,
              transition.expiresAt,
              transition.revokedAt,
              transition.revocationReason,
              tx.transactionId,
              eventSignedDateMs,
              transition.autoRenewStatus,
              now,
              tx.originalTransactionId,
              existing.latest_signed_date_ms,
            )
            .run()
        : await db
            .prepare(
              `UPDATE store_subscriptions
               SET environment = ?,
                   product_id = ?,
                   status = ?,
                   expires_at = ?,
                   revoked_at = ?,
                   revocation_reason = ?,
                   latest_transaction_id = ?,
                   latest_signed_date_ms = ?,
                   auto_renew_status = ?,
                   updated_at = ?
               WHERE original_transaction_id = ?
                 AND latest_signed_date_ms <= ?
                 AND revoked_at IS NULL
                 AND status != 'revoked'`,
            )
          .bind(
            tx.environment,
            tx.productId,
            transition.status,
            transition.expiresAt,
            transition.revokedAt,
            transition.revocationReason,
            tx.transactionId,
            eventSignedDateMs,
            transition.autoRenewStatus,
            now,
            tx.originalTransactionId,
            existing.latest_signed_date_ms,
          )
          .run();
    if (!updated.success) throw new Error('storekit_write_failed');
    const outcome: NotificationOutcome = (updated.meta?.changes ?? 0) === 1 ? 'applied' : 'ignored_stale';
    await recordNotification(db, {
      notificationUuid,
      notificationType,
      subtype,
      environment,
      originalTransactionId: tx.originalTransactionId,
      signedDateMs,
      outcome,
      receivedAt: now,
    });
    return json(200, { received: true, outcome, status: transition.status });
  }

  // No existing subscription row: can only insert if appAccountToken resolves to an existing user.
  if (!tx.appAccountToken) {
    await recordNotification(db, {
      notificationUuid,
      notificationType,
      subtype,
      environment,
      originalTransactionId: tx.originalTransactionId,
      signedDateMs,
      outcome: 'ignored_unknown_user',
      receivedAt: now,
    });
    return json(200, { received: true, outcome: 'ignored_unknown_user' });
  }

  const user = await db
    .prepare('SELECT id FROM user WHERE id = ?')
    .bind(tx.appAccountToken)
    .first<{ id: string }>();
  if (!user) {
    await recordNotification(db, {
      notificationUuid,
      notificationType,
      subtype,
      environment,
      originalTransactionId: tx.originalTransactionId,
      signedDateMs,
      outcome: 'ignored_unknown_user',
      receivedAt: now,
    });
    return json(200, { received: true, outcome: 'ignored_unknown_user' });
  }

  const inserted = await db
    .prepare(
      `INSERT INTO store_subscriptions (
         original_transaction_id, user_id, environment, product_id, status, expires_at,
         in_app_ownership_type, revoked_at, revocation_reason, latest_transaction_id,
         latest_signed_date_ms, auto_renew_status, owner_change_count, last_owner_changed_at,
         last_reconciled_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
       ON CONFLICT(original_transaction_id) DO NOTHING`,
    )
    .bind(
      tx.originalTransactionId,
      user.id,
      tx.environment,
      tx.productId,
      transition.status,
      transition.expiresAt,
      tx.inAppOwnershipType,
      transition.revokedAt,
      transition.revocationReason,
      tx.transactionId,
      eventSignedDateMs,
      transition.autoRenewStatus,
      now,
      now,
    )
    .run();
  if (!inserted.success) throw new Error('storekit_write_failed');
  const outcome: NotificationOutcome = (inserted.meta?.changes ?? 0) === 1 ? 'applied' : 'ignored_stale';
  await recordNotification(db, {
    notificationUuid,
    notificationType,
    subtype,
    environment,
    originalTransactionId: tx.originalTransactionId,
    signedDateMs,
    outcome,
    receivedAt: now,
  });
  return json(200, { received: true, outcome, status: transition.status });
}
