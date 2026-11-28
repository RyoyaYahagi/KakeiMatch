import type { AccountEnv } from './account-db';
import { parseStoreKitConfig, type StoreKitEnv } from './entitlements';
import { verifyStoreKitTransactionJws, type VerifiedStoreKitTransaction } from './storekit-jws';

type Db = AccountEnv['ACCOUNT_DB'];

export interface StoreKitTransactionOptions {
  /** Trust-anchor injection is for synthetic unit tests only. No HTTP/binding can supply it. */
  storeKitTestTrustAnchor?: Uint8Array;
}

type SubscriptionStatus = 'active' | 'in_grace_period' | 'in_billing_retry' | 'expired' | 'revoked';

type ExistingSubscriptionRow = {
  original_transaction_id: string;
  user_id: string;
  environment: 'Sandbox' | 'Production';
  product_id: string;
  status: SubscriptionStatus;
  expires_at: number | null;
  in_app_ownership_type: 'PURCHASED' | 'FAMILY_SHARED';
  revoked_at: number | null;
  revocation_reason: number | null;
  latest_transaction_id: string;
  latest_signed_date_ms: number;
  auto_renew_status: number | null;
  owner_change_count: number;
  last_owner_changed_at: number | null;
};

const EXPECTED_BUNDLE_ID = 'jp.kakeimatch.ios';
const OWNER_TRANSFER_FRESHNESS_MS = 10 * 60 * 1000;
const OWNER_TRANSFER_COOLDOWN_SECONDS = 24 * 60 * 60;

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

function initialStatusForNewRow(tx: VerifiedStoreKitTransaction, now: number): SubscriptionStatus {
  if (tx.revokedAt !== null) return 'revoked';
  if (tx.expiresAt !== null && tx.expiresAt <= now) return 'expired';
  return 'active';
}

/**
 * Handles POST /api/native/storekit/transactions after Native boundary guards
 * (Origin/Cookie, rate limit, 64KiB body limit, strict key allowlist, Native session).
 *
 * Client POSTs never downgrade status (never transition to expired/revoked) and
 * never clear an existing revoked_at; downgrades and revocations belong to
 * Apple notifications and scheduled reconciliation (PR 2+).
 */
export async function handleStoreKitTransactionPost(
  db: Db,
  env: StoreKitEnv,
  sessionUserId: string,
  signedTransactionInfo: string,
  now: number,
  options: StoreKitTransactionOptions = {},
): Promise<Response> {
  const config = parseStoreKitConfig(env);
  if (!config) {
    return json(503, { error: 'not_configured' });
  }

  let tx: VerifiedStoreKitTransaction;
  try {
    tx = await verifyStoreKitTransactionJws(signedTransactionInfo, {
      now: new Date(now * 1000),
      expectedBundleId: EXPECTED_BUNDLE_ID,
      testTrustAnchor: options.storeKitTestTrustAnchor,
    });
  } catch {
    return json(403, { error: 'invalid_jws' });
  }

  if (!config.allowedEnvironments.includes(tx.environment)) {
    return json(403, { error: 'environment_not_allowed' });
  }
  if (tx.inAppOwnershipType !== 'PURCHASED') {
    return json(403, { error: 'unsupported_ownership_type' });
  }
  if (!Object.prototype.hasOwnProperty.call(config.productPlans, tx.productId)) {
    return json(422, { error: 'unknown_product' });
  }

  // Read existing row first, decide in application logic, then apply a conditional write
  // guarded by latest_signed_date_ms (no branching inside a D1 batch).
  const existing = await db
    .prepare(
      `SELECT original_transaction_id, user_id, environment, product_id, status, expires_at,
              in_app_ownership_type, revoked_at, revocation_reason, latest_transaction_id,
              latest_signed_date_ms, auto_renew_status, owner_change_count, last_owner_changed_at
       FROM store_subscriptions
       WHERE original_transaction_id = ?`,
    )
    .bind(tx.originalTransactionId)
    .first<ExistingSubscriptionRow>();

  if (!existing) {
    const status = initialStatusForNewRow(tx, now);
    const inserted = await db
      .prepare(
        `INSERT INTO store_subscriptions (
           original_transaction_id, user_id, environment, product_id, status, expires_at,
           in_app_ownership_type, revoked_at, revocation_reason, latest_transaction_id,
           latest_signed_date_ms, auto_renew_status, owner_change_count, last_owner_changed_at,
           last_reconciled_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, ?, ?)
         ON CONFLICT(original_transaction_id) DO NOTHING`,
      )
      .bind(
        tx.originalTransactionId,
        sessionUserId,
        tx.environment,
        tx.productId,
        status,
        tx.expiresAt,
        tx.inAppOwnershipType,
        tx.revokedAt,
        tx.revocationReason,
        tx.transactionId,
        tx.signedDateMs,
        now,
        now,
      )
      .run();
    if (!inserted.success) throw new Error('storekit_write_failed');
    return json(200, {
      synced: (inserted.meta?.changes ?? 0) === 1,
      status,
      expiresAt: tx.expiresAt,
      productId: tx.productId,
    });
  }

  const nowMs = now * 1000;
  const sameOwner =
    existing.user_id === sessionUserId ||
    (tx.appAccountToken !== null && tx.appAccountToken.toLowerCase() === sessionUserId.toLowerCase());

  let ownerChanged = false;
  let nextUserId = existing.user_id;
  let nextOwnerChangeCount = existing.owner_change_count;
  let nextLastOwnerChangedAt = existing.last_owner_changed_at;

  if (!sameOwner) {
    // Rebinding to a different user requires a fresh JWS (<= 10 min old) and at most
    // one owner change per 24 hours for the same transaction.
    if (nowMs - tx.signedDateMs > OWNER_TRANSFER_FRESHNESS_MS) {
      return json(200, { synced: false, reason: 'stale_owner_transfer' });
    }
    if (
      existing.last_owner_changed_at !== null &&
      now - existing.last_owner_changed_at < OWNER_TRANSFER_COOLDOWN_SECONDS
    ) {
      return json(200, { synced: false, reason: 'owner_change_rate_limited' });
    }
    ownerChanged = true;
    nextUserId = sessionUserId;
    nextOwnerChangeCount = existing.owner_change_count + 1;
    nextLastOwnerChangedAt = now;
  } else if (existing.user_id !== sessionUserId) {
    // appAccountToken matches the current session user_id: treat as the same owner.
    nextUserId = sessionUserId;
  }

  if (tx.signedDateMs < existing.latest_signed_date_ms) {
    return json(200, { synced: false, reason: 'stale_transaction' });
  }

  // Client POST never clears revoked_at, never downgrades status, and never shrinks expires_at.
  let nextStatus: SubscriptionStatus = existing.status;
  let nextExpiresAt: number | null = existing.expires_at;
  let nextProductId = existing.product_id;

  if (existing.revoked_at === null && tx.revokedAt === null) {
    nextProductId = tx.productId;
    if (existing.expires_at === null) {
      nextExpiresAt = null;
    } else if (tx.expiresAt === null) {
      nextExpiresAt = null;
    } else if (tx.expiresAt > existing.expires_at) {
      nextExpiresAt = tx.expiresAt;
    }
    if (nextExpiresAt === null || nextExpiresAt > now) {
      if (
        existing.status === 'expired' ||
        existing.status === 'in_billing_retry' ||
        existing.status === 'in_grace_period'
      ) {
        nextStatus = 'active';
      }
    }
  }

  const updated = ownerChanged
    ? await db
        .prepare(
          `UPDATE store_subscriptions
           SET user_id = ?,
               environment = ?,
               product_id = ?,
               status = ?,
               expires_at = ?,
               latest_transaction_id = ?,
               latest_signed_date_ms = ?,
               owner_change_count = ?,
               last_owner_changed_at = ?,
               updated_at = ?
           WHERE original_transaction_id = ?
             AND latest_signed_date_ms <= ?
             AND (last_owner_changed_at IS NULL OR last_owner_changed_at <= ?)`,
        )
        .bind(
          nextUserId,
          tx.environment,
          nextProductId,
          nextStatus,
          nextExpiresAt,
          tx.transactionId,
          tx.signedDateMs,
          nextOwnerChangeCount,
          nextLastOwnerChangedAt,
          now,
          tx.originalTransactionId,
          existing.latest_signed_date_ms,
          now - OWNER_TRANSFER_COOLDOWN_SECONDS,
        )
        .run()
    : await db
        .prepare(
          `UPDATE store_subscriptions
           SET user_id = ?,
               environment = ?,
               product_id = ?,
               status = ?,
               expires_at = ?,
               latest_transaction_id = ?,
               latest_signed_date_ms = ?,
               updated_at = ?
           WHERE original_transaction_id = ?
             AND latest_signed_date_ms <= ?`,
        )
        .bind(
          nextUserId,
          tx.environment,
          nextProductId,
          nextStatus,
          nextExpiresAt,
          tx.transactionId,
          tx.signedDateMs,
          now,
          tx.originalTransactionId,
          existing.latest_signed_date_ms,
        )
        .run();

  if (!updated.success) throw new Error('storekit_write_failed');
  const applied = (updated.meta?.changes ?? 0) === 1;
  if (ownerChanged && applied) {
    // Log owner transfer without any user, transaction, or JWS identifiers.
    console.info('storekit_subscription_owner_changed', {
      environment: tx.environment,
      ownerChangeCount: nextOwnerChangeCount,
    });
  }

  return json(200, {
    synced: applied,
    status: nextStatus,
    expiresAt: nextExpiresAt,
    productId: nextProductId,
  });
}
