-- Data-minimal replay protection for standalone category suggestions.
CREATE TABLE ai_category_suggestion_flows (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  flow_id TEXT NOT NULL,
  month TEXT NOT NULL,
  day TEXT NOT NULL,
  ip_day_mac TEXT NOT NULL,
  input_mac TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  dispatched INTEGER NOT NULL DEFAULT 0 CHECK (dispatched IN (0, 1)),
  counted INTEGER NOT NULL DEFAULT 1 CHECK (counted IN (0, 1)),
  PRIMARY KEY (user_id, flow_id)
);
CREATE INDEX ai_category_suggestion_flows_month ON ai_category_suggestion_flows(user_id, month);
CREATE INDEX ai_category_suggestion_flows_day ON ai_category_suggestion_flows(user_id, day);
CREATE INDEX ai_category_suggestion_flows_ip_day ON ai_category_suggestion_flows(ip_day_mac, day);
