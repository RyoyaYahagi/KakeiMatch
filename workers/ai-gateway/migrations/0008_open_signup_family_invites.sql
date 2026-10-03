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
-- never create accounts. The optional target is stored as a SHA-256 digest of
-- the normalized email. Used rows stay as tombstones so a token cannot be reused;
-- after account deletion used_by_user_id becomes NULL while used_at stays set.
CREATE TABLE family_invites (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  target_email_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  CHECK (used_by_user_id IS NULL OR used_at IS NOT NULL)
);
CREATE INDEX family_invites_used_by_user_id_idx ON family_invites(used_by_user_id);
