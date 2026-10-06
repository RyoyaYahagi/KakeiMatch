-- Guests use AI without signing up. A guest is a user row with no Passkey or
-- session; the device keeps a random secret and D1 keeps only its digest.
-- created_ip_day_mac is an HMAC of the client address keyed by the Tokyo day:
-- it caps guests per address for that day and cannot be read back or linked across days.
CREATE TABLE guest_devices (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  created_day TEXT NOT NULL,
  created_ip_day_mac TEXT NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX guest_devices_ip_day ON guest_devices(created_ip_day_mac, created_day);

-- Only receipt flows count toward a plan. Contact flows are rate limited instead.
ALTER TABLE ai_receipt_flows ADD COLUMN kind TEXT NOT NULL DEFAULT 'receipt'
  CHECK (kind IN ('receipt', 'contact-submit', 'contact-transcribe', 'contact-interview'));
-- Tokyo calendar day, for the guest daily quota and per-address caps.
ALTER TABLE ai_receipt_flows ADD COLUMN day TEXT;
ALTER TABLE ai_receipt_flows ADD COLUMN ip_day_mac TEXT;
CREATE INDEX ai_receipt_flows_user_day ON ai_receipt_flows(user_id, day);
CREATE INDEX ai_receipt_flows_ip_day ON ai_receipt_flows(ip_day_mac, day);
