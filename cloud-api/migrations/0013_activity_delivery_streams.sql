-- Per-stream sequence watermarks so retries across multiple devices or streams never double-count missions.
ALTER TABLE account_activity ADD COLUMN delivery_streams TEXT NOT NULL DEFAULT '{}';
UPDATE system_metadata SET value='13' WHERE key='schema_version';
