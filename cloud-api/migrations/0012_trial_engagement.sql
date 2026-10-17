-- Trial engagement: when the account last did real work and how many missions it ran. Counters only, no content.
ALTER TABLE account_activity ADD COLUMN last_active_at INTEGER;
ALTER TABLE account_activity ADD COLUMN last_mission_at INTEGER;
ALTER TABLE account_activity ADD COLUMN missions_started_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account_activity ADD COLUMN missions_completed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account_activity ADD COLUMN last_agent_working INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account_activity ADD COLUMN last_mission_running INTEGER NOT NULL DEFAULT 0;
-- Legacy rows only hold first_* milestones, which would pin "last active" to the day of the first use.
-- For an account that did use the system, last_app_seen_at is the latest signal we have: the best available estimate.
UPDATE account_activity
SET last_active_at = COALESCE(last_app_seen_at, first_mission_at, first_agent_at)
WHERE last_active_at IS NULL
  AND (first_agent_at IS NOT NULL OR first_mission_at IS NOT NULL OR first_usage_day IS NOT NULL);
UPDATE account_activity SET last_mission_at = first_mission_at, missions_started_count = 1, missions_completed_count = 1 WHERE first_mission_at IS NOT NULL AND missions_completed_count = 0;
UPDATE system_metadata SET value='12' WHERE key='schema_version';
