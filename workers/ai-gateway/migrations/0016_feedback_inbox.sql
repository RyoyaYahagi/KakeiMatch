CREATE TABLE feedback_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  kind TEXT CHECK (kind IN ('bug','improvement','question')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewing','issue_created','resolved','dismissed')),
  message_original_encrypted TEXT NOT NULL,
  message_sanitized TEXT NOT NULL,
  ai_summary TEXT,
  diagnostic_json_sanitized TEXT,
  github_issue_number INTEGER CHECK (github_issue_number > 0),
  github_issue_url TEXT,
  github_issue_state TEXT NOT NULL DEFAULT 'ready' CHECK (github_issue_state IN ('ready','in_progress','unknown','done')),
  resolved_at INTEGER,
  retention_expires_at INTEGER NOT NULL
);
CREATE INDEX feedback_submissions_status_created_idx ON feedback_submissions(status, created_at DESC);
CREATE INDEX feedback_submissions_retention_idx ON feedback_submissions(retention_expires_at);
CREATE UNIQUE INDEX feedback_submissions_issue_number_idx ON feedback_submissions(github_issue_number) WHERE github_issue_number IS NOT NULL;

ALTER TABLE contact_submissions ADD COLUMN feedback_id TEXT REFERENCES feedback_submissions(id) ON DELETE SET NULL;

CREATE TABLE admin_audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  admin_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('feedback_original_viewed','feedback_analysis_requested','feedback_issue_requested','feedback_analyzed','feedback_issue_created','feedback_status_updated','feedback_deleted')),
  target_type TEXT NOT NULL CHECK (target_type = 'feedback'),
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX admin_audit_log_target_idx ON admin_audit_log(target_type, target_id, created_at DESC);
