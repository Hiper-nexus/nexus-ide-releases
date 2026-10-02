-- Trial start and administrator assignment are runtime decisions after verified
-- OAuth identity. This migration creates neither users nor trial entitlements.
ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('user', 'admin'));
ALTER TABLE accounts ADD COLUMN trial_started_at INTEGER;
ALTER TABLE accounts ADD COLUMN trial_expires_at INTEGER
  CHECK (
    (trial_started_at IS NULL AND trial_expires_at IS NULL)
    OR (trial_started_at IS NOT NULL AND trial_expires_at IS NOT NULL
      AND trial_started_at >= 0 AND trial_expires_at > trial_started_at)
  );
ALTER TABLE accounts ADD COLUMN suspended_at INTEGER;
ALTER TABLE accounts ADD COLUMN suspension_reason TEXT
  CHECK (suspension_reason IS NULL OR length(suspension_reason) <= 500);
ALTER TABLE accounts ADD COLUMN last_seen_at INTEGER;

CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  target_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('suspend', 'resume', 'extend_trial')),
  details TEXT NOT NULL CHECK (json_valid(details)),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
) STRICT;
CREATE INDEX admin_audit_actor_created_idx ON admin_audit(actor_account_id, created_at);
CREATE INDEX admin_audit_target_created_idx ON admin_audit(target_account_id, created_at);
CREATE INDEX admin_audit_created_idx ON admin_audit(created_at);

UPDATE system_metadata SET value = '2' WHERE key = 'schema_version';
