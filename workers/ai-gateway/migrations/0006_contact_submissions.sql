-- Idempotency metadata only. Never store inquiry text, recordings or user identity in Issue bodies.
CREATE TABLE contact_submissions (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  flow_id TEXT NOT NULL,
  input_mac TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready','classifying','sending','unknown','failed','done')),
  kind TEXT CHECK (kind IN ('bug','improvement','question')),
  issue_number INTEGER CHECK (issue_number > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, flow_id)
);
