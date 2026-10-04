-- Protected household keys for device sync (Issue #143). Each row is the household key
-- encrypted with the user's recovery code (src/lib/encrypted-household-format.ts). The
-- recovery code and the plain key never reach the server. One row per key generation.
CREATE TABLE sync_household_keys (
  household_id TEXT NOT NULL REFERENCES sync_households(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  protected_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, generation)
);
