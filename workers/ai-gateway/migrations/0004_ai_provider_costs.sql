-- Operational metadata only. Never persist prompts, receipts or provider bodies.
CREATE TABLE IF NOT EXISTS ai_provider_cost_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  flow_id TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('gemini', 'jev')),
  requested_model TEXT NOT NULL,
  model TEXT NOT NULL,
  pricing_version TEXT,
  billing_mode TEXT,
  input_usd_per_million_micros INTEGER,
  output_usd_per_million_micros INTEGER,
  input_tokens INTEGER CHECK (input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  thinking_tokens INTEGER CHECK (thinking_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens >= 0),
  estimated_cost_usd_micros INTEGER CHECK (estimated_cost_usd_micros >= 0),
  metering_status TEXT NOT NULL CHECK (metering_status IN ('metered', 'unknown')),
  safe_error_code TEXT,
  dispatched_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS ai_provider_cost_user_time ON ai_provider_cost_events(user_id, dispatched_at);
CREATE INDEX IF NOT EXISTS ai_provider_cost_provider_time ON ai_provider_cost_events(provider, dispatched_at);
