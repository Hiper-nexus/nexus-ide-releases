-- Minimal app observations. No content or runtime identifiers are retained.
CREATE TABLE account_activity (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  first_app_seen_at INTEGER NOT NULL,
  last_app_seen_at INTEGER NOT NULL,
  first_agent_at INTEGER,
  first_mission_at INTEGER,
  first_usage_day TEXT,
  returned_at INTEGER
) STRICT;
CREATE INDEX account_activity_presence_idx ON account_activity(last_app_seen_at);
CREATE TABLE account_activity_days (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  PRIMARY KEY(account_id, day)
) STRICT;
CREATE INDEX account_activity_days_day_idx ON account_activity_days(day);
UPDATE system_metadata SET value='9' WHERE key='schema_version';
