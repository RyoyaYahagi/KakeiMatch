-- Device sync with a storage location the user owns, such as Google Drive (Issue #143).
-- The device stores encrypted chunks there itself; D1 keeps only the opaque file
-- reference, size and SHA-256, never the ciphertext. NULL means the server's own
-- provider (KakeiMatch Cloud). Publishing a version also moves the household to the
-- version's location, so a failed switch leaves the old location in use.
ALTER TABLE sync_versions ADD COLUMN storage TEXT CHECK (storage IS NULL OR storage IN ('google-drive'));
ALTER TABLE sync_chunks ADD COLUMN external_ref TEXT;
