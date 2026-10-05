-- Tracks provider writes from the moment they are accepted until their result
-- is committed or queued for deletion. A pending row is never expired by time:
-- if a Worker stops before recording the result, destructive deletion fails
-- closed until an operator can determine the provider outcome.
CREATE TABLE sync_storage_operations (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'settled')),
  created_at INTEGER NOT NULL
);
CREATE INDEX sync_storage_operations_household_idx
  ON sync_storage_operations(household_id, state);

-- Account deletion is also gated in SQLite so paths outside the HTTP handler
-- cannot cascade-delete a household while a provider write is unresolved.
CREATE TRIGGER sync_storage_block_user_delete
BEFORE DELETE ON user
WHEN EXISTS (
  SELECT 1 FROM sync_households h
  JOIN sync_storage_operations o ON o.household_id = h.id
  WHERE h.owner_user_id = OLD.id AND o.state = 'pending'
)
BEGIN
  SELECT RAISE(ABORT, 'sync_storage_pending');
END;

-- A queued key is never writable again, even after cleanup removed its queue
-- row. Concurrent/late deletion calls therefore cannot erase a retried write.
-- Uploads that need to retry a failed integrity check must start a new version.
CREATE TABLE sync_retired_object_keys (
  object_key TEXT PRIMARY KEY NOT NULL
);
INSERT OR IGNORE INTO sync_retired_object_keys(object_key)
  SELECT object_key FROM sync_object_deletions;
CREATE TRIGGER sync_storage_retire_deleted_key
AFTER INSERT ON sync_object_deletions
BEGIN
  INSERT OR IGNORE INTO sync_retired_object_keys(object_key) VALUES (NEW.object_key);
END;
