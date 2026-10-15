-- Additive only. Why a refresh token was revoked, when it matters for reuse detection:
-- 'superseded' = an unused successor replaced by a retry inside the grace window. Its holder never
-- received it legitimately, so presenting it later revokes the family while the family is still alive.
-- 'family' = revoked with its family; presenting it again does nothing. NULL = logout or older rows.
ALTER TABLE refresh_tokens ADD COLUMN revoked_reason TEXT;
UPDATE system_metadata SET value='11' WHERE key='schema_version';
