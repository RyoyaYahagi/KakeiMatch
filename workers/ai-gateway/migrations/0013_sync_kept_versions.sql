-- Versions the user did not choose when resolving a conflict (Issue #143 §4).
-- A published version that another device's choice replaced is marked here and,
-- like a conflict version, is never removed by history cleanup. It stays until
-- the user deletes it or deletes all cloud sync data.
ALTER TABLE sync_versions ADD COLUMN kept_at INTEGER;
