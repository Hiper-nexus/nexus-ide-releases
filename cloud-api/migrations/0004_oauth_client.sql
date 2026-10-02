-- Which desktop client started the OAuth flow. The callback picks the deep
-- link base from this column, never from the request, so a login started by
-- Nexus Shot always lands on nexus-shot:// and one started by the IDE on nexus://.
ALTER TABLE oauth_states ADD COLUMN client TEXT NOT NULL DEFAULT 'nexus'
  CHECK (client IN ('nexus', 'shot'));

UPDATE system_metadata SET value = '4' WHERE key = 'schema_version';
