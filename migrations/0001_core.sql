-- PostgreSQL baseline port. IDs are UUID text supplied by the Worker/importer.
-- All timestamp columns store UTC epoch milliseconds, never seconds or ISO text.
-- STRICT enforces storage types; JSON remains serialized text.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team')),
  stripe_customer_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
) STRICT;

CREATE TABLE identities (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google')),
  provider_user_id TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  CONSTRAINT identities_provider_subject_unique UNIQUE (provider, provider_user_id)
) STRICT;
CREATE INDEX identities_account_idx ON identities(account_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  last_used_at INTEGER,
  csrf_hash TEXT,
  channel TEXT NOT NULL DEFAULT 'desktop' CHECK (channel IN ('desktop', 'web'))
) STRICT;
CREATE INDEX sessions_account_idx ON sessions(account_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  rotated_from TEXT,
  used_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  channel TEXT NOT NULL DEFAULT 'desktop' CHECK (channel IN ('desktop', 'web'))
) STRICT;
CREATE INDEX refresh_tokens_account_idx ON refresh_tokens(account_id);
CREATE INDEX refresh_tokens_expiry_idx ON refresh_tokens(expires_at);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google')),
  code_verifier TEXT NOT NULL,
  app_state TEXT,
  code_challenge TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  expires_at INTEGER NOT NULL,
  flow TEXT NOT NULL DEFAULT 'desktop' CHECK (flow IN ('desktop', 'web')),
  web_state_hash TEXT
) STRICT;
CREATE INDEX oauth_states_expiry_idx ON oauth_states(expires_at);

CREATE TABLE auth_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  used_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  code_challenge TEXT
) STRICT;
CREATE INDEX auth_codes_account_idx ON auth_codes(account_id);
CREATE INDEX auth_codes_expiry_idx ON auth_codes(expires_at);

CREATE TABLE teams (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
) STRICT;
CREATE INDEX teams_owner_idx ON teams(owner_account_id);
CREATE INDEX teams_created_idx ON teams(created_at);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  CONSTRAINT team_members_pk PRIMARY KEY (team_id, account_id),
  CONSTRAINT team_members_one_team_per_account UNIQUE (account_id)
) STRICT;

CREATE TABLE team_invites (
  code_hash TEXT PRIMARY KEY NOT NULL,
  code_prefix TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  max_uses INTEGER NOT NULL DEFAULT 10,
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
) STRICT;
CREATE INDEX team_invites_team_idx ON team_invites(team_id);
CREATE INDEX team_invites_creator_idx ON team_invites(created_by);
CREATE INDEX team_invites_expiry_idx ON team_invites(expires_at);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('account', 'team')),
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'pro', 'team')),
  status TEXT NOT NULL,
  seats INTEGER NOT NULL DEFAULT 1,
  current_period_end INTEGER,
  grace_until INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
) STRICT;
CREATE INDEX subscriptions_account_idx ON subscriptions(account_id, owner_type);
CREATE INDEX subscriptions_team_idx ON subscriptions(team_id, owner_type);
CREATE INDEX subscriptions_customer_idx ON subscriptions(stripe_customer_id);

CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  processed_at INTEGER,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
) STRICT;
CREATE INDEX stripe_events_processing_idx ON stripe_events(processed_at, created_at);

CREATE TABLE cron_schedules (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  definition TEXT NOT NULL CHECK (json_valid(definition)),
  definition_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'deleted')),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  CONSTRAINT cron_schedules_pk PRIMARY KEY (account_id, project_id, schedule_id)
) STRICT;
CREATE INDEX cron_schedules_project_status_idx ON cron_schedules(account_id, project_id, status);
CREATE INDEX cron_schedules_cleanup_idx ON cron_schedules(status, updated_at);

CREATE TABLE cron_leases (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  occurrence_at INTEGER NOT NULL,
  token_hash TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  CONSTRAINT cron_leases_pk PRIMARY KEY (account_id, project_id, schedule_id, occurrence_at)
) STRICT;
CREATE INDEX cron_leases_expiry_idx ON cron_leases(expires_at);

CREATE TABLE sync_projects (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  entities TEXT NOT NULL CHECK (json_valid(entities)),
  entity_count INTEGER NOT NULL CHECK (entity_count >= 0 AND entity_count <= 1000),
  state_bytes INTEGER NOT NULL CHECK (state_bytes >= 0 AND state_bytes <= 196608),
  updated_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
  CONSTRAINT sync_projects_pk PRIMARY KEY (account_id, project_id)
) STRICT;
CREATE INDEX sync_projects_account_updated_idx ON sync_projects(account_id, updated_at);

CREATE TABLE system_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;
INSERT OR IGNORE INTO system_metadata (key, value) VALUES ('schema_version', '1');
