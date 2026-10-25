-- Native credentials are never Web cookies or Web AI JWTs. No household data.
CREATE TABLE native_app_keys (
  key_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  app_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('production','development')),
  public_key TEXT NOT NULL,
  receipt TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK(counter >= 0),
  guest_user_id TEXT UNIQUE REFERENCES user(id) ON DELETE SET NULL,
  account_user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE native_sessions (
  token_hash TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES native_app_keys(key_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  auth_session_id TEXT REFERENCES session(id) ON DELETE CASCADE,
  identity TEXT NOT NULL CHECK(identity IN ('account','guest')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK((identity='account' AND auth_session_id IS NOT NULL) OR (identity='guest' AND auth_session_id IS NULL))
);
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
