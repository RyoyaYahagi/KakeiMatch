-- Native sessions no longer point at Better Auth sessions. Rebuild the table
-- without auth_session_id and keep every row. The child tables are copied out
-- and back in, so dropping the old parent cannot cascade-delete them.
-- account_deletion_tombstones and its trigger stay: they still guard against
-- reviving deleted accounts.
CREATE TABLE native_sessions_next (
  token_hash TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES native_app_keys(key_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  identity TEXT NOT NULL CHECK(identity IN ('account','guest')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
INSERT INTO native_sessions_next (token_hash, key_id, user_id, identity, created_at, expires_at)
  SELECT token_hash, key_id, user_id, identity, created_at, expires_at FROM native_sessions;

CREATE TABLE native_challenges_kept AS SELECT * FROM native_challenges;
CREATE TABLE native_ai_tokens_kept AS SELECT * FROM native_ai_tokens;
DROP TABLE native_ai_tokens;
DROP TABLE native_challenges;
DROP TABLE native_sessions;
ALTER TABLE native_sessions_next RENAME TO native_sessions;
CREATE INDEX native_sessions_expiry ON native_sessions(expires_at);

CREATE TABLE native_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('attest','guest','token','passkey')),
  key_id TEXT NOT NULL,
  session_hash TEXT REFERENCES native_sessions(token_hash) ON DELETE CASCADE,
  ceremony_kind TEXT CHECK(ceremony_kind IN ('authenticate','register')),
  target_user_id TEXT REFERENCES user(id) ON DELETE CASCADE,
  verification_cookie TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX native_challenges_expiry ON native_challenges(expires_at);
CREATE TABLE native_ai_tokens (
  token_hash TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL REFERENCES native_sessions(token_hash) ON DELETE CASCADE,
  audience TEXT NOT NULL CHECK(audience='kakeimatch-native-ai'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX native_ai_tokens_expiry ON native_ai_tokens(expires_at);

INSERT INTO native_challenges (id, challenge, purpose, key_id, session_hash, ceremony_kind, target_user_id, verification_cookie, created_at, expires_at, used_at)
  SELECT id, challenge, purpose, key_id, session_hash, ceremony_kind, target_user_id, verification_cookie, created_at, expires_at, used_at FROM native_challenges_kept;
INSERT INTO native_ai_tokens (token_hash, session_hash, audience, created_at, expires_at)
  SELECT token_hash, session_hash, audience, created_at, expires_at FROM native_ai_tokens_kept;
DROP TABLE native_challenges_kept;
DROP TABLE native_ai_tokens_kept;

-- Better Auth tables. No native table references them after the rebuild above.
DROP TABLE account_invite;
DROP TABLE passkey;
DROP TABLE verification;
DROP TABLE account;
DROP TABLE session;
DROP TABLE ai_usage;
