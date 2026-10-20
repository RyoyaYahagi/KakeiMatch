-- Jev runs against one of two interchangeable upstreams (OpenCode Console and
-- OpenRouter). Each one can fail on its own, so each needs its own circuit:
-- a failure streak at one upstream must not pause the other, or a fallback
-- could never run. Metering keeps provider='jev' for both upstreams, so prices,
-- quotas and cost caps are unchanged.
CREATE TABLE ai_provider_circuits_next (
  provider TEXT PRIMARY KEY CHECK (provider IN ('gemini', 'jev', 'jev:opencode', 'jev:openrouter')),
  opened_at INTEGER,
  reason TEXT CHECK (reason IN ('provider_failures', 'unknown_metering')),
  resumed_at INTEGER NOT NULL DEFAULT 0,
  resumed_after_event INTEGER NOT NULL DEFAULT 0
);
-- An open Jev pause is preserved for both upstreams; the operator resumes the
-- one that should serve traffic. Closed rows carry no pause and are not copied.
INSERT INTO ai_provider_circuits_next(provider, opened_at, reason, resumed_at, resumed_after_event)
  SELECT 'jev:opencode', opened_at, reason, resumed_at, resumed_after_event
  FROM ai_provider_circuits WHERE provider='jev' AND opened_at IS NOT NULL;
INSERT INTO ai_provider_circuits_next(provider, opened_at, reason, resumed_at, resumed_after_event)
  SELECT 'jev:openrouter', opened_at, reason, resumed_at, resumed_after_event
  FROM ai_provider_circuits WHERE provider='jev' AND opened_at IS NOT NULL;
DROP TABLE ai_provider_circuits;
ALTER TABLE ai_provider_circuits_next RENAME TO ai_provider_circuits;
