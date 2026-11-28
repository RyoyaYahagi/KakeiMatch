import type { AccountD1BatchResult, AccountEnv } from './account-db';
import { parseStoreKitConfig, type StoreKitEnv } from './entitlements';
import {
  fetchAllSubscriptionStatuses,
  parseStoreKitApiConfig,
  type StoreKitApiEnv,
} from './storekit-api';
import {
  verifyStoreKitJws,
  verifyStoreKitTransactionJws,
  type StoreKitEnvironment,
  type VerifiedStoreKitTransaction,
} from './storekit-jws';

export type StoreKitReconcileEnv = AccountEnv & StoreKitEnv & StoreKitApiEnv;

export interface ReconcileStoreSubscriptionsOptions {
  fetch?: typeof fetch;
  batchLimit?: number;
  reconcileIntervalSeconds?: number;
  expiredLookbackSeconds?: number;
  /** Trust-anchor injection is for synthetic unit tests only. No HTTP/binding can supply it. */
  storeKitTestTrustAnchor?: Uint8Array;
}

export interface ReconcileSummary {
  skipped: boolean;
  checked: number;
  updated: number;
  unchanged: number;
  errors: number;
}

type SubscriptionStatus = 'active' | 'in_grace_period' | 'in_billing_retry' | 'expired' | 'revoked';

type CandidateSubscriptionRow = {
  original_transaction_id: string;
  environment: StoreKitEnvironment;
  product_id: string;
  status: SubscriptionStatus;
  expires_at: number | null;
  revoked_at: number | null;
  latest_transaction_id: string;
  latest_signed_date_ms: number;
  auto_renew_status: number | null;
};

interface ParsedRenewalInfo {
  signedDateMs: number | null;
  autoRenewStatus: 0 | 1 | null;
  gracePeriodExpiresAt: number | null;
}

const EXPECTED_BUNDLE_ID = 'jp.kakeimatch.ios';
const DEFAULT_BATCH_LIMIT = 50;
const DEFAULT_RECONCILE_INTERVAL_SECONDS = 20 * 60 * 60;
const DEFAULT_EXPIRED_LOOKBACK_SECONDS = 30 * 24 * 60 * 60;

function parseRenewalInfo(payload: Record<string, unknown>, nowMs: number): ParsedRenewalInfo {
  let signedDateMs: number | null = null;
  if (payload.signedDate !== undefined && payload.signedDate !== null) {
    if (typeof payload.signedDate !== 'number' || !Number.isSafeInteger(payload.signedDate) || payload.signedDate < 0) {
      throw new Error('invalid_renewal_payload');
    }
    if (payload.signedDate > nowMs) {
      throw new Error('future_signed_date');
    }
    signedDateMs = payload.signedDate;
  }

  let autoRenewStatus: 0 | 1 | null = null;
  if (payload.autoRenewStatus !== undefined && payload.autoRenewStatus !== null) {
    if (payload.autoRenewStatus !== 0 && payload.autoRenewStatus !== 1) {
      throw new Error('invalid_renewal_payload');
    }
    autoRenewStatus = payload.autoRenewStatus;
  }

  let gracePeriodExpiresAt: number | null = null;
  if (payload.gracePeriodExpiresDate !== undefined && payload.gracePeriodExpiresDate !== null) {
    if (
      typeof payload.gracePeriodExpiresDate !== 'number' ||
      !Number.isSafeInteger(payload.gracePeriodExpiresDate) ||
      payload.gracePeriodExpiresDate < 0
    ) {
      throw new Error('invalid_renewal_payload');
    }
    gracePeriodExpiresAt = Math.floor(payload.gracePeriodExpiresDate / 1000);
  }

  return { signedDateMs, autoRenewStatus, gracePeriodExpiresAt };
}

function mapAppleStatusToLocal(
  appleStatus: number,
  tx: VerifiedStoreKitTransaction,
  renewal: ParsedRenewalInfo | null,
  now: number,
): {
  status: SubscriptionStatus;
  expiresAt: number | null;
  revokedAt: number | null;
  revocationReason: number | null;
} {
  if (tx.revokedAt !== null || appleStatus === 5) {
    return {
      status: 'revoked',
      expiresAt: tx.expiresAt,
      revokedAt: tx.revokedAt ?? now,
      revocationReason: tx.revocationReason,
    };
  }
  switch (appleStatus) {
    case 4:
      return {
        status: 'in_grace_period',
        expiresAt: renewal?.gracePeriodExpiresAt ?? tx.expiresAt,
        revokedAt: null,
        revocationReason: null,
      };
    case 3:
      return {
        status: 'in_billing_retry',
        expiresAt: tx.expiresAt,
        revokedAt: null,
        revocationReason: null,
      };
    case 2:
      return {
        status: 'expired',
        expiresAt: tx.expiresAt,
        revokedAt: null,
        revocationReason: null,
      };
    case 1:
      return {
        status: tx.expiresAt !== null && tx.expiresAt <= now ? 'expired' : 'active',
        expiresAt: tx.expiresAt,
        revokedAt: null,
        revocationReason: null,
      };
    default:
      throw new Error('unsupported_apple_status');
  }
}

/**
 * Daily cron reconciliation batch: heals subscriptions that missed ASSN V2 notifications
 * by querying Apple's Get All Subscription Statuses API and verifying the returned JWS payloads.
 *
 * Invariants:
 * - Fail-closed when StoreKit or App Store Server API bindings are not configured.
 * - Never queries or un-revokes already revoked subscriptions.
 * - Never overwrites newer state with an older signedDate.
 * - Errors on individual subscriptions are isolated so the remaining batch continues.
 */
export async function reconcileStoreSubscriptions(
  env: StoreKitReconcileEnv,
  now: number,
  options: ReconcileStoreSubscriptionsOptions = {},
): Promise<ReconcileSummary> {
  const storeKitConfig = parseStoreKitConfig(env);
  const apiConfig = parseStoreKitApiConfig(env);
  if (!storeKitConfig || !apiConfig) {
    return { skipped: true, checked: 0, updated: 0, unchanged: 0, errors: 0 };
  }

  const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const reconcileInterval = options.reconcileIntervalSeconds ?? DEFAULT_RECONCILE_INTERVAL_SECONDS;
  const expiredLookback = options.expiredLookbackSeconds ?? DEFAULT_EXPIRED_LOOKBACK_SECONDS;
  const staleBefore = now - reconcileInterval;
  const expiredSince = now - expiredLookback;
  const nowDate = new Date(now * 1000);
  const nowMs = now * 1000;

  const envPlaceholders = storeKitConfig.allowedEnvironments.map(() => '?').join(', ');
  const candidateStmt = env.ACCOUNT_DB
    .prepare(
      `SELECT original_transaction_id, environment, product_id, status, expires_at,
              revoked_at, latest_transaction_id, latest_signed_date_ms, auto_renew_status
       FROM store_subscriptions
       WHERE environment IN (${envPlaceholders})
         AND status != 'revoked'
         AND revoked_at IS NULL
         AND (
           (status IN ('active', 'in_grace_period', 'in_billing_retry')
            AND (last_reconciled_at IS NULL OR last_reconciled_at <= ? OR (expires_at IS NOT NULL AND expires_at <= ?)))
           OR
           (status = 'expired'
            AND (expires_at IS NULL OR expires_at >= ?)
            AND (last_reconciled_at IS NULL OR last_reconciled_at <= ?))
         )
       ORDER BY COALESCE(last_reconciled_at, 0) ASC, expires_at ASC
       LIMIT ?`,
    )
    .bind(
      ...storeKitConfig.allowedEnvironments,
      staleBefore,
      now,
      expiredSince,
      staleBefore,
      batchLimit,
    );

  const [queryResult] = await env.ACCOUNT_DB.batch<AccountD1BatchResult>([candidateStmt]);
  if (!queryResult?.success) {
    throw new Error('storekit_reconcile_query_failed');
  }

  const rows = (queryResult.results as CandidateSubscriptionRow[] | undefined) ?? [];
  const summary: ReconcileSummary = {
    skipped: false,
    checked: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
  };

  for (const row of rows) {
    summary.checked += 1;
    try {
      const apiResult = await fetchAllSubscriptionStatuses(
        apiConfig,
        row.original_transaction_id,
        row.environment,
        {
          fetch: options.fetch,
          nowSeconds: () => now,
          bundleId: EXPECTED_BUNDLE_ID,
        },
      );

      const match = apiResult.items.find(item => item.originalTransactionId === row.original_transaction_id);
      if (!apiResult.found || !match) {
        await env.ACCOUNT_DB
          .prepare('UPDATE store_subscriptions SET last_reconciled_at = ? WHERE original_transaction_id = ?')
          .bind(now, row.original_transaction_id)
          .run();
        summary.unchanged += 1;
        continue;
      }

      const tx = await verifyStoreKitTransactionJws(match.signedTransactionInfo, {
        now: nowDate,
        expectedBundleId: EXPECTED_BUNDLE_ID,
        testTrustAnchor: options.storeKitTestTrustAnchor,
      });

      if (
        tx.originalTransactionId !== row.original_transaction_id ||
        tx.environment !== row.environment ||
        tx.inAppOwnershipType !== 'PURCHASED' ||
        !Object.prototype.hasOwnProperty.call(storeKitConfig.productPlans, tx.productId)
      ) {
        summary.errors += 1;
        continue;
      }

      let renewal: ParsedRenewalInfo | null = null;
      if (match.signedRenewalInfo) {
        const renewalPayload = await verifyStoreKitJws(match.signedRenewalInfo, {
          now: nowDate,
          testTrustAnchor: options.storeKitTestTrustAnchor,
        });
        if (
          renewalPayload.originalTransactionId !== undefined &&
          renewalPayload.originalTransactionId !== row.original_transaction_id
        ) {
          summary.errors += 1;
          continue;
        }
        renewal = parseRenewalInfo(renewalPayload, nowMs);
      }

      const effectiveSignedDateMs = Math.max(tx.signedDateMs, renewal?.signedDateMs ?? 0);

      // Invariant: never overwrite newer state with an older signedDate.
      if (effectiveSignedDateMs < row.latest_signed_date_ms) {
        await env.ACCOUNT_DB
          .prepare('UPDATE store_subscriptions SET last_reconciled_at = ? WHERE original_transaction_id = ?')
          .bind(now, row.original_transaction_id)
          .run();
        summary.unchanged += 1;
        continue;
      }

      const mapped = mapAppleStatusToLocal(match.appleStatus, tx, renewal, now);
      const nextAutoRenewStatus = renewal?.autoRenewStatus ?? row.auto_renew_status;

      const updated = await env.ACCOUNT_DB
        .prepare(
          `UPDATE store_subscriptions
           SET product_id = ?,
               status = ?,
               expires_at = ?,
               revoked_at = ?,
               revocation_reason = ?,
               latest_transaction_id = ?,
               latest_signed_date_ms = ?,
               auto_renew_status = ?,
               last_reconciled_at = ?,
               updated_at = ?
           WHERE original_transaction_id = ?
             AND latest_signed_date_ms <= ?
             AND revoked_at IS NULL
             AND status != 'revoked'`,
        )
        .bind(
          tx.productId,
          mapped.status,
          mapped.expiresAt,
          mapped.revokedAt,
          mapped.revocationReason,
          tx.transactionId,
          effectiveSignedDateMs,
          nextAutoRenewStatus,
          now,
          now,
          row.original_transaction_id,
          row.latest_signed_date_ms,
        )
        .run();

      if (!updated.success) throw new Error('storekit_reconcile_write_failed');
      if ((updated.meta?.changes ?? 0) === 1) {
        summary.updated += 1;
      } else {
        summary.unchanged += 1;
      }
    } catch {
      summary.errors += 1;
      // Log without user, transaction, or JWS identifiers.
      console.warn('storekit_reconcile_item_failed', { environment: row.environment });
    }
  }

  return summary;
}
