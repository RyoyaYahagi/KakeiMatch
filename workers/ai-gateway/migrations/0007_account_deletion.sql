-- Keep only the opaque ID needed to prevent stale, in-flight auth work from
-- recreating a deleted account. No email, name, credential, or household data.
CREATE TABLE account_deletion_tombstones (
  user_id TEXT PRIMARY KEY NOT NULL
);

CREATE TRIGGER prevent_deleted_account_recreation
BEFORE INSERT ON user
WHEN EXISTS (SELECT 1 FROM account_deletion_tombstones WHERE user_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'deleted_account_id');
END;
