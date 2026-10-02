-- Existing flows retain their quota semantics; new flows start provisionally.
ALTER TABLE ai_receipt_flows ADD COLUMN dispatched INTEGER NOT NULL DEFAULT 1 CHECK (dispatched IN (0,1));
-- Reuse the metering ledger for admission reservations. No second cost counter.
ALTER TABLE ai_provider_cost_events ADD COLUMN reserved_cost_usd_micros INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cost_usd_micros >= 0);
-- Earlier unknown requests get the default floor without inventing actual costs.
UPDATE ai_provider_cost_events SET reserved_cost_usd_micros=CASE provider WHEN 'gemini' THEN 50000 ELSE 5000 END WHERE metering_status='unknown';
CREATE TABLE ai_provider_circuits (
  provider TEXT PRIMARY KEY CHECK (provider IN ('gemini', 'jev')),
  opened_at INTEGER,
  reason TEXT CHECK (reason IN ('provider_failures', 'unknown_metering')),
  resumed_at INTEGER NOT NULL DEFAULT 0,
  resumed_after_event INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ai_provider_cost_time ON ai_provider_cost_events(dispatched_at);
