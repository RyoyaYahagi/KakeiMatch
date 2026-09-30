-- Usage/idempotency metadata only. No receipt or provider bodies are stored.
-- Legacy ai_usage is retained but excluded from the new quota and usage queries.
CREATE TABLE ai_receipt_flows (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  flow_id TEXT NOT NULL,
  month TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  image_mac TEXT NOT NULL,
  category_mac TEXT,
  gemini_attempts INTEGER NOT NULL DEFAULT 0 CHECK (gemini_attempts BETWEEN 0 AND 3),
  jev_attempts INTEGER NOT NULL DEFAULT 0 CHECK (jev_attempts BETWEEN 0 AND 3),
  PRIMARY KEY (user_id, flow_id)
);
CREATE INDEX ai_receipt_flows_month ON ai_receipt_flows(user_id, month);
