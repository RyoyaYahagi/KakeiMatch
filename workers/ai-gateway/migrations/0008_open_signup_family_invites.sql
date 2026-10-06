-- Open signup keeps the user row out of D1 until a Passkey has been verified.
-- A ticket holds the requested email/name for at most a few minutes and is
-- deleted when the account is created. Only the token digest is stored.
CREATE TABLE account_signup_tickets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX account_signup_tickets_expires_at_idx ON account_signup_tickets(expires_at);

-- Family invites grant the unlimited-quota plan to an existing account. They
-- never create accounts. The token is the only invite capability. Used rows stay
-- as tombstones so a token cannot be reused, and
-- after account deletion used_by_user_id becomes NULL while used_at stays set.
CREATE TABLE family_invites (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  CHECK (used_by_user_id IS NULL OR used_at IS NOT NULL)
);
CREATE INDEX family_invites_used_by_user_id_idx ON family_invites(used_by_user_id);

-- Keep the Family account cap in D1 so operator plan changes cannot bypass it.
CREATE TABLE account_family_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_accounts INTEGER NOT NULL CHECK (max_accounts > 0)
);
INSERT INTO account_family_settings(id, max_accounts) VALUES (1, 5);

-- Conditions stay in WHEN, not in a CASE inside the body: D1 splits remote migrations at the CASE's closing keyword.
CREATE TRIGGER account_entitlements_family_insert_capacity
BEFORE INSERT ON account_entitlements
WHEN NEW.plan = 'family' AND
  (SELECT COUNT(*) FROM account_entitlements WHERE plan = 'family' AND user_id <> NEW.user_id) >=
  (SELECT max_accounts FROM account_family_settings WHERE id = 1)
BEGIN
  SELECT RAISE(ABORT, 'family_capacity_reached');
END;

CREATE TRIGGER account_entitlements_family_update_capacity
BEFORE UPDATE OF plan ON account_entitlements
WHEN NEW.plan = 'family' AND OLD.plan <> 'family' AND
  (SELECT COUNT(*) FROM account_entitlements WHERE plan = 'family') >=
  (SELECT max_accounts FROM account_family_settings WHERE id = 1)
BEGIN
  SELECT RAISE(ABORT, 'family_capacity_reached');
END;

CREATE TRIGGER account_family_settings_capacity
BEFORE UPDATE OF max_accounts ON account_family_settings
WHEN NEW.max_accounts < (SELECT COUNT(*) FROM account_entitlements WHERE plan = 'family')
BEGIN
  SELECT RAISE(ABORT, 'family_capacity_below_current_count');
END;
