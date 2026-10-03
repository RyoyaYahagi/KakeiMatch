-- Device sync control plane (Issue #143). Opt-in only; no household plaintext,
-- email, or name is stored here. Encrypted versions live in the sync storage
-- provider; D1 keeps ownership, device credentials, version order, and
-- bookkeeping needed for compare-and-swap publication.

CREATE TABLE sync_households (
  -- Random UUID chosen by the first device. It is never used for authorization.
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  current_version_id TEXT,
  current_sequence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleting')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sync_devices (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES sync_households(id) ON DELETE CASCADE,
  -- SHA-256 of a server-issued 256-bit credential. The credential is shown once.
  credential_hash TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX sync_devices_household_idx ON sync_devices(household_id);

CREATE TABLE sync_versions (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES sync_households(id) ON DELETE CASCADE,
  -- Base version the uploader started from. Not a foreign key: retained history
  -- is pruned, but a conflict version must keep its recorded parent.
  parent_version_id TEXT,
  generation INTEGER NOT NULL,
  -- Server-issued ordering number, assigned only when the version becomes current.
  sequence INTEGER,
  state TEXT NOT NULL CHECK (state IN ('uploading', 'published', 'conflict')),
  chunk_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  -- Random per upload so a deleted version's object keys are never reused.
  object_prefix TEXT NOT NULL UNIQUE,
  created_by_device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  publish_request_id TEXT,
  -- Only unpublished uploads expire.
  expires_at INTEGER NOT NULL
);
CREATE INDEX sync_versions_household_state_idx ON sync_versions(household_id, state);

CREATE TABLE sync_chunks (
  household_id TEXT NOT NULL REFERENCES sync_households(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES sync_versions(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  -- pending: claimed before the provider write; stored: provider confirmed it.
  state TEXT NOT NULL CHECK (state IN ('pending', 'stored')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (version_id, chunk_index)
);
CREATE INDEX sync_chunks_household_idx ON sync_chunks(household_id);

-- Idempotency records. One row per request ID per household.
CREATE TABLE sync_requests (
  household_id TEXT NOT NULL REFERENCES sync_households(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('begin', 'publish')),
  body_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('created', 'published', 'conflict')),
  version_id TEXT NOT NULL,
  sequence INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, request_id)
);
CREATE INDEX sync_requests_created_idx ON sync_requests(created_at);

-- Transactional outbox for provider objects. Any removed chunk row (version
-- pruning, household deletion, or account deletion cascading from user) queues
-- its object here in the same transaction, so no object is left unreferenced.
CREATE TABLE sync_object_deletions (
  object_key TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL
);
CREATE INDEX sync_object_deletions_household_idx ON sync_object_deletions(household_id);

CREATE TRIGGER sync_chunks_queue_object_deletion
BEFORE DELETE ON sync_chunks
BEGIN
  INSERT OR IGNORE INTO sync_object_deletions(object_key, household_id)
  VALUES (OLD.object_key, OLD.household_id);
END;

-- Opaque IDs of deleted households. Prevents an old device from recreating a
-- household whose cloud data was deleted. No owner, email, or name is kept.
CREATE TABLE sync_deleted_households (
  household_id TEXT PRIMARY KEY NOT NULL
);

CREATE TRIGGER sync_households_record_deletion
AFTER DELETE ON sync_households
BEGIN
  INSERT OR IGNORE INTO sync_deleted_households(household_id) VALUES (OLD.id);
END;
