-- Additive only. Reuse of a rotated refresh token now revokes its family (the rotated_from tree),
-- not every session of the account, so each session records the refresh token issued with it.
-- Sessions created before this migration keep refresh_id NULL: a family revocation cannot reach them,
-- and they simply expire within the 15-minute session TTL.
ALTER TABLE sessions ADD COLUMN refresh_id TEXT;
CREATE INDEX IF NOT EXISTS sessions_refresh_idx ON sessions(refresh_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_rotated_from_idx ON refresh_tokens(rotated_from);
-- Diagnostics for refresh reuse. No token hash, no IP: the account, what happened and which family.
CREATE TABLE auth_events (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('refresh_reuse_grace', 'refresh_reuse_family_revoked')),
  family_root TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX auth_events_account_created_idx ON auth_events(account_id, created_at);
UPDATE system_metadata SET value='10' WHERE key='schema_version';
