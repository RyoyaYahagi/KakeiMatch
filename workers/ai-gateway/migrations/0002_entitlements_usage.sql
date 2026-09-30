-- Account billing metadata only. Household, receipt, statement, and ledger data
-- must never be added to this database.
CREATE TABLE IF NOT EXISTS account_entitlements (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'pro', 'family')),
  monthly_ai_limit INTEGER CHECK (monthly_ai_limit IS NULL OR monthly_ai_limit >= 0),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((plan = 'family' AND monthly_ai_limit IS NULL) OR (plan IN ('free', 'pro') AND monthly_ai_limit IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS ai_usage (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  gemini_used INTEGER NOT NULL DEFAULT 0 CHECK (gemini_used >= 0),
  jev_used INTEGER NOT NULL DEFAULT 0 CHECK (jev_used >= 0),
  PRIMARY KEY (user_id, month)
);
