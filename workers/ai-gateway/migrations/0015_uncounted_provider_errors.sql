-- A flow whose provider answered with an error status did no work for the user,
-- so it does not count toward a plan. Its cost event is still kept for the global caps.
-- Timeouts and invalid responses stay counted: the provider may have done the work.
ALTER TABLE ai_receipt_flows ADD COLUMN counted INTEGER NOT NULL DEFAULT 1 CHECK (counted IN (0, 1));
