-- StoreKit subscription entitlement and notification metadata only.
-- Household, receipt, statement, ledger data, raw JWS payloads, and Apple customer identifiers
-- must never be added to this database.

CREATE TABLE IF NOT EXISTS store_subscriptions (
  original_transaction_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('Sandbox', 'Production')),
  product_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'in_grace_period', 'in_billing_retry', 'expired', 'revoked')),
  expires_at INTEGER,
  in_app_ownership_type TEXT NOT NULL CHECK (in_app_ownership_type IN ('PURCHASED', 'FAMILY_SHARED')),
  revoked_at INTEGER,
  revocation_reason INTEGER,
  latest_transaction_id TEXT NOT NULL,
  latest_signed_date_ms INTEGER NOT NULL,
  auto_renew_status INTEGER CHECK (auto_renew_status IS NULL OR auto_renew_status IN (0, 1)),
  owner_change_count INTEGER NOT NULL DEFAULT 0 CHECK (owner_change_count >= 0),
  last_owner_changed_at INTEGER,
  last_reconciled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS store_subscriptions_user_status_expires_idx
  ON store_subscriptions(user_id, status, expires_at);

CREATE INDEX IF NOT EXISTS store_subscriptions_env_status_expires_reconciled_idx
  ON store_subscriptions(environment, status, expires_at, last_reconciled_at);

CREATE TABLE IF NOT EXISTS store_notifications (
  notification_uuid TEXT PRIMARY KEY NOT NULL,
  notification_type TEXT NOT NULL,
  subtype TEXT,
  environment TEXT NOT NULL CHECK (environment IN ('Sandbox', 'Production')),
  original_transaction_id TEXT,
  signed_date INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'ignored_stale', 'ignored_unknown_user', 'ignored_non_tx', 'ignored_env')),
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS store_notifications_received_at_idx
  ON store_notifications(received_at);

CREATE INDEX IF NOT EXISTS store_notifications_original_tx_idx
  ON store_notifications(original_transaction_id);
