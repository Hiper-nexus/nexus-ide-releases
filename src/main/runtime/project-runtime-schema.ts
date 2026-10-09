import { createHash } from 'node:crypto';
import {
  HANDOFF_ROUNDED_OPERATION_IDENTITY_SCHEMA,
  ORCHESTRATION_PROJECT_MIGRATION_SPECS,
} from './project-runtime-orchestration-migrations';

export interface ProjectMigrationSpec {
  id: string;
  schemaVersion: number;
  appVersion: string;
  sql: string;
}

export interface ProjectMigration extends Readonly<ProjectMigrationSpec> {
  checksum: string;
}

const MIGRATION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

function canonicalMigration(spec: ProjectMigrationSpec): string {
  return [spec.id, String(spec.schemaVersion), spec.appVersion, spec.sql].join('\0');
}

export function migrationChecksum(spec: ProjectMigrationSpec): string {
  return createHash('sha256').update(canonicalMigration(spec)).digest('hex');
}

export function createProjectMigration(
  spec: ProjectMigrationSpec,
): ProjectMigration {
  if (!MIGRATION_ID_PATTERN.test(spec.id)) {
    throw new Error(`invalid project migration id: ${spec.id}`);
  }
  if (
    !Number.isSafeInteger(spec.schemaVersion) ||
    spec.schemaVersion <= 0 ||
    spec.schemaVersion > 2_147_483_647
  ) {
    throw new Error(`invalid project schema version: ${spec.schemaVersion}`);
  }
  if (
    spec.appVersion.trim() !== spec.appVersion ||
    spec.appVersion.length === 0 ||
    spec.appVersion.length > 64
  ) {
    throw new Error(`invalid project migration app version: ${spec.appVersion}`);
  }
  if (spec.sql.trim().length === 0) {
    throw new Error(`project migration has no SQL: ${spec.id}`);
  }

  return Object.freeze({
    ...spec,
    checksum: migrationChecksum(spec),
  });
}

export function validateProjectMigrations(
  migrations: readonly ProjectMigration[],
): readonly ProjectMigration[] {
  if (migrations.length === 0) {
    throw new Error('at least one project migration is required');
  }

  const ids = new Set<string>();
  let previousVersion = 0;
  for (const migration of migrations) {
    createProjectMigration(migration);
    if (!CHECKSUM_PATTERN.test(migration.checksum)) {
      throw new Error(`invalid migration checksum: ${migration.id}`);
    }
    if (migrationChecksum(migration) !== migration.checksum) {
      throw new Error(`configured migration checksum is stale: ${migration.id}`);
    }
    if (ids.has(migration.id)) {
      throw new Error(`duplicate project migration id: ${migration.id}`);
    }
    if (migration.schemaVersion <= previousVersion) {
      throw new Error('project schema versions must be strictly increasing');
    }
    ids.add(migration.id);
    previousVersion = migration.schemaVersion;
  }
  return Object.freeze(
    migrations.map((migration) => Object.freeze({ ...migration })),
  );
}

const INITIAL_PROJECT_SCHEMA = `
CREATE TABLE missions (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL,
  squad_id            TEXT,
  milestones_json     TEXT NOT NULL DEFAULT '[]',
  orch_session_id     TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE mission_panes (
  id                  TEXT PRIMARY KEY,
  mission_id          TEXT NOT NULL,
  adapter_id          TEXT NOT NULL,
  model               TEXT,
  account_id          TEXT,
  effort              TEXT,
  cwd                 TEXT,
  title               TEXT NOT NULL,
  agent_name          TEXT,
  role                TEXT NOT NULL DEFAULT 'worker',
  pane_id             TEXT,
  scope_json          TEXT,
  allowed_tools_json  TEXT,
  allowed_skills_json TEXT,
  created_at          INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE TABLE handoffs (
  id             TEXT PRIMARY KEY,
  mission_id     TEXT,
  session_id     TEXT,
  from_agent     TEXT,
  status         TEXT NOT NULL,
  summary        TEXT NOT NULL,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  delivered      INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1)),
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  mission_id  TEXT,
  parent_id   TEXT,
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE TABLE todos (
  id          TEXT PRIMARY KEY,
  mission_id  TEXT,
  task_id     TEXT,
  text        TEXT NOT NULL,
  completed   INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE notes (
  id          TEXT PRIMARY KEY,
  mission_id  TEXT,
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL,
  tags_json   TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE TABLE usage_events (
  id             TEXT PRIMARY KEY,
  mission_id     TEXT,
  pane_id        TEXT,
  provider       TEXT NOT NULL,
  model          TEXT,
  event_type     TEXT NOT NULL,
  input_units    INTEGER NOT NULL DEFAULT 0,
  output_units   INTEGER NOT NULL DEFAULT 0,
  cost_micros    INTEGER NOT NULL DEFAULT 0,
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  occurred_at    INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL,
  FOREIGN KEY (pane_id) REFERENCES mission_panes(id) ON DELETE SET NULL
);

CREATE TABLE media_artifacts (
  id             TEXT PRIMARY KEY,
  mission_id     TEXT,
  media_type     TEXT NOT NULL,
  provider       TEXT,
  storage_key    TEXT NOT NULL,
  sha256         TEXT,
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL
);

CREATE TABLE gamification_events (
  id             TEXT PRIMARY KEY,
  mission_id     TEXT,
  event_type     TEXT NOT NULL,
  points         INTEGER NOT NULL,
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  occurred_at    INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL
);

CREATE TABLE audit_events (
  id             TEXT PRIMARY KEY,
  mission_id     TEXT,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  occurred_at    INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL
);

CREATE TABLE memory_entries (
  id             TEXT PRIMARY KEY,
  mission_id     TEXT,
  kind           TEXT NOT NULL,
  content        TEXT NOT NULL,
  source_uri     TEXT,
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE TABLE browser_artifacts (
  id             TEXT PRIMARY KEY,
  mission_id     TEXT,
  session_id     TEXT,
  artifact_type  TEXT NOT NULL,
  storage_key    TEXT NOT NULL,
  metadata_json  TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL
);

CREATE INDEX idx_mission_panes_mission ON mission_panes(mission_id);
CREATE INDEX idx_handoffs_mission_created ON handoffs(mission_id, created_at);
CREATE INDEX idx_tasks_mission_status ON tasks(mission_id, status);
CREATE INDEX idx_todos_mission_position ON todos(mission_id, position);
CREATE INDEX idx_notes_mission_updated ON notes(mission_id, updated_at);
CREATE INDEX idx_usage_occurred ON usage_events(occurred_at);
CREATE INDEX idx_media_mission_created ON media_artifacts(mission_id, created_at);
CREATE INDEX idx_gamification_occurred ON gamification_events(occurred_at);
CREATE INDEX idx_audit_occurred ON audit_events(occurred_at);
CREATE INDEX idx_memory_mission_kind ON memory_entries(mission_id, kind);
CREATE INDEX idx_browser_mission_created ON browser_artifacts(mission_id, created_at);
`;

/**
 * V1 modeled todos as independent checklist rows and used `notes` for the
 * future knowledge graph. V2 adds the missing list ownership plus dedicated
 * sticky-note/layout tables without overloading those knowledge records.
 */
const SCOPED_UI_DOMAIN_SCHEMA = `
ALTER TABLE todos RENAME TO todos_v1;

CREATE TABLE todo_lists (
  id         TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL
);

CREATE TABLE todos (
  id          TEXT PRIMARY KEY,
  list_id     TEXT NOT NULL,
  mission_id  TEXT,
  task_id     TEXT,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'done')),
  position    INTEGER NOT NULL CHECK (position >= 0),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (list_id) REFERENCES todo_lists(id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE (list_id, position)
);

INSERT INTO todo_lists (id, updated_at)
SELECT COALESCE(mission_id, 'global'), MAX(updated_at)
FROM todos_v1
GROUP BY COALESCE(mission_id, 'global');

INSERT INTO todos
  (id, list_id, mission_id, task_id, name, status, position, created_at,
   updated_at)
SELECT id, COALESCE(mission_id, 'global'), mission_id, task_id, text,
       CASE completed WHEN 1 THEN 'done' ELSE 'todo' END,
       position, created_at, updated_at
FROM todos_v1;

DROP TABLE todos_v1;

CREATE TABLE sticky_notes (
  id             TEXT PRIMARY KEY,
  text           TEXT NOT NULL DEFAULT '',
  x              REAL NOT NULL,
  y              REAL NOT NULL,
  w              REAL NOT NULL CHECK (w > 0),
  h              REAL NOT NULL CHECK (h > 0),
  color          TEXT NOT NULL,
  linked_pane_id TEXT,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE workspace_layout (
  singleton   INTEGER PRIMARY KEY CHECK (singleton = 1),
  layout_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_todos_list_position ON todos(list_id, position);
CREATE INDEX idx_todos_mission_position ON todos(mission_id, position);
CREATE INDEX idx_sticky_notes_updated ON sticky_notes(updated_at);
`;

const SCOPED_GAMIFICATION_SCHEMA = `
CREATE TABLE xp_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_key     TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,
  mission_id     TEXT,
  agent_category TEXT,
  effort         TEXT,
  cost_usd       REAL,
  evidence       TEXT,
  retro          INTEGER NOT NULL DEFAULT 0 CHECK (retro IN (0, 1)),
  points         INTEGER NOT NULL,
  rule_version   INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE gamification_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX idx_xp_events_day ON xp_events(created_at);
CREATE INDEX idx_xp_events_mission ON xp_events(mission_id, created_at);
`;

const CONTEXT_WORKFLOW_RUNTIME_SCHEMA = `
CREATE TABLE mission_contracts (
  mission_id       TEXT PRIMARY KEY,
  revision         INTEGER NOT NULL CHECK (revision > 0),
  contract_hash    TEXT NOT NULL UNIQUE,
  context_revision TEXT NOT NULL,
  contract_json    TEXT NOT NULL,
  author_id        TEXT NOT NULL,
  author_session_id TEXT NOT NULL,
  author_provider  TEXT NOT NULL,
  frozen_at        INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE TABLE workflow_states (
  mission_id    TEXT PRIMARY KEY,
  revision      INTEGER NOT NULL CHECK (revision > 0),
  stage         TEXT NOT NULL,
  workflow_json TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES mission_contracts(mission_id)
    ON DELETE CASCADE
);

CREATE TABLE sensor_evidence (
  id            TEXT PRIMARY KEY,
  mission_id    TEXT NOT NULL,
  sensor_id     TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  diff_hash     TEXT NOT NULL,
  passed        INTEGER NOT NULL CHECK (passed IN (0, 1)),
  evidence_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES mission_contracts(mission_id)
    ON DELETE CASCADE
);

CREATE TABLE review_reports (
  review_id   TEXT PRIMARY KEY,
  mission_id  TEXT NOT NULL,
  diff_hash   TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES mission_contracts(mission_id)
    ON DELETE CASCADE
);

CREATE TABLE event_ledger (
  sequence      INTEGER PRIMARY KEY CHECK (sequence > 0),
  id            TEXT NOT NULL UNIQUE,
  mission_id    TEXT,
  event_type    TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash    TEXT NOT NULL UNIQUE,
  event_json    TEXT NOT NULL,
  occurred_at   TEXT NOT NULL
);

CREATE TABLE worktree_state (
  scope_key    TEXT PRIMARY KEY,
  revision     INTEGER NOT NULL CHECK (revision >= 0),
  records_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE merge_queue_state (
  scope_key  TEXT PRIMARY KEY,
  revision   INTEGER NOT NULL CHECK (revision >= 0),
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE context_sync_outbox (
  id               TEXT PRIMARY KEY,
  aggregate_type   TEXT NOT NULL,
  aggregate_id     TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  payload_json     TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'conflict')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE context_sync_conflicts (
  id             TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  local_json     TEXT NOT NULL,
  remote_json    TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  resolved_at    INTEGER
);

CREATE INDEX idx_sensor_evidence_mission_sensor
  ON sensor_evidence(mission_id, sensor_id, created_at);
CREATE INDEX idx_review_reports_mission_diff
  ON review_reports(mission_id, diff_hash, created_at);
CREATE INDEX idx_event_ledger_mission_sequence
  ON event_ledger(mission_id, sequence);
CREATE INDEX idx_context_sync_outbox_status
  ON context_sync_outbox(status, created_at);
CREATE INDEX idx_context_sync_conflicts_open
  ON context_sync_conflicts(resolved_at, created_at);
`;

const SCOPED_VOICE_TRANSCRIPTS_SCHEMA = `
CREATE TABLE voice_transcript_entries (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence   INTEGER NOT NULL CHECK (sequence > 0),
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text       TEXT NOT NULL,
  audio_url  TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, sequence)
);

CREATE INDEX idx_voice_transcript_session_sequence
  ON voice_transcript_entries(session_id, sequence);
`;

/**
 * One durable receipt per job is sufficient to reject a replay of the latest
 * scheduled occurrence after a crash. The database itself is already bound to
 * projectId + checkoutId, while installationId remains a local runtime
 * coordinate and never enters portable/synced payloads.
 */
const SCOPED_CRON_EXECUTION_STATE_SCHEMA = `
CREATE TABLE cron_execution_state (
  job_id           TEXT PRIMARY KEY,
  scheduled_for    INTEGER NOT NULL CHECK (scheduled_for >= 0),
  execution_mode   TEXT NOT NULL CHECK (execution_mode IN ('shared', 'local')),
  status           TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'suppressed')),
  reason           TEXT,
  lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  error            TEXT,
  updated_at       INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE INDEX idx_cron_execution_state_status_updated
  ON cron_execution_state(status, updated_at);
`;

/**
 * Draft bytes remain local runtime state until Nexus has verified the source
 * hashes and an identity/session-independent reviewer. Applied authority is portable
 * through the target file plus its versioned attestation sidecar.
 */
const CONTEXT_DRAFT_ATTESTATION_SCHEMA = `
CREATE TABLE context_drafts (
  id                   TEXT PRIMARY KEY,
  mission_id           TEXT,
  target_path          TEXT NOT NULL,
  content              TEXT NOT NULL,
  content_hash         TEXT NOT NULL,
  expected_target_hash TEXT,
  source_refs_json     TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (
    status IN ('proposed', 'approved', 'applied', 'rejected')
  ),
  author_id             TEXT NOT NULL,
  author_session_id     TEXT NOT NULL,
  author_provider       TEXT NOT NULL,
  reviewer_id           TEXT,
  reviewer_session_id   TEXT,
  reviewer_provider     TEXT,
  review_rationale      TEXT,
  attestation_id        TEXT,
  applied_commit        TEXT,
  created_at            INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at            INTEGER NOT NULL CHECK (updated_at >= 0),
  reviewed_at           INTEGER CHECK (reviewed_at IS NULL OR reviewed_at >= 0),
  applied_at            INTEGER CHECK (applied_at IS NULL OR applied_at >= 0),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_context_drafts_active_target
  ON context_drafts(target_path)
  WHERE status IN ('proposed', 'approved');
CREATE INDEX idx_context_drafts_status_updated
  ON context_drafts(status, updated_at);
CREATE INDEX idx_context_drafts_mission_updated
  ON context_drafts(mission_id, updated_at);
`;

/**
 * Legacy handoffs are retained as delivery metadata, but remain explicitly
 * unverified. Only new rows whose evidence IDs resolve against the current
 * frozen workflow receive a trusted immutable binding.
 */
const TRUSTED_HANDOFF_EVIDENCE_SCHEMA = `
ALTER TABLE handoffs
  ADD COLUMN evidence_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE handoffs
  ADD COLUMN evidence_trusted INTEGER NOT NULL DEFAULT 0
    CHECK (evidence_trusted IN (0, 1));
ALTER TABLE handoffs ADD COLUMN context_revision TEXT;
ALTER TABLE handoffs ADD COLUMN contract_hash TEXT;
ALTER TABLE handoffs ADD COLUMN base_sha TEXT;
ALTER TABLE handoffs ADD COLUMN head_sha TEXT;
ALTER TABLE handoffs ADD COLUMN diff_hash TEXT;
ALTER TABLE handoffs
  ADD COLUMN workflow_revision INTEGER
    CHECK (workflow_revision IS NULL OR workflow_revision > 0);

CREATE INDEX idx_handoffs_session_evidence
  ON handoffs(session_id, evidence_trusted, created_at);

CREATE TRIGGER handoffs_claim_binding_immutable
BEFORE UPDATE OF
  mission_id, session_id, from_agent, status, summary, artifacts_json,
  evidence_ids_json, evidence_trusted, context_revision, contract_hash,
  base_sha, head_sha, diff_hash, workflow_revision, created_at
ON handoffs
BEGIN
  SELECT RAISE(ABORT, 'handoff claim and evidence binding are immutable');
END;
`;

const HANDOFF_DELIVERY_RECEIPTS_SCHEMA = `
ALTER TABLE handoffs
  ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'queued'
    CHECK (delivery_state IN ('queued', 'submitted', 'acknowledged', 'consumed'));
ALTER TABLE handoffs ADD COLUMN submitted_at INTEGER;
ALTER TABLE handoffs ADD COLUMN acknowledged_at INTEGER;
ALTER TABLE handoffs ADD COLUMN consumed_at INTEGER;
UPDATE handoffs
SET delivery_state = CASE WHEN delivered = 1 THEN 'submitted' ELSE 'queued' END,
    submitted_at = CASE WHEN delivered = 1 THEN created_at ELSE NULL END;
CREATE INDEX idx_handoffs_delivery_state
  ON handoffs(mission_id, delivery_state, created_at);
`;

const CONTEXT_DRAFT_SUPERSESSION_SCHEMA = `
ALTER TABLE context_drafts RENAME TO context_drafts_pre_supersession;

CREATE TABLE context_drafts (
  id                   TEXT PRIMARY KEY,
  mission_id           TEXT,
  target_path          TEXT NOT NULL,
  content              TEXT NOT NULL,
  content_hash         TEXT NOT NULL,
  expected_target_hash TEXT,
  source_refs_json     TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (
    status IN ('proposed', 'approved', 'applied', 'rejected', 'superseded')
  ),
  author_id             TEXT NOT NULL,
  author_session_id     TEXT NOT NULL,
  author_provider       TEXT NOT NULL,
  reviewer_id           TEXT,
  reviewer_session_id   TEXT,
  reviewer_provider     TEXT,
  review_rationale      TEXT,
  attestation_id        TEXT,
  applied_commit        TEXT,
  created_at            INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at            INTEGER NOT NULL CHECK (updated_at >= 0),
  reviewed_at           INTEGER CHECK (reviewed_at IS NULL OR reviewed_at >= 0),
  applied_at            INTEGER CHECK (applied_at IS NULL OR applied_at >= 0),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL
);

INSERT INTO context_drafts
SELECT * FROM context_drafts_pre_supersession;
DROP TABLE context_drafts_pre_supersession;

CREATE UNIQUE INDEX idx_context_drafts_active_target
  ON context_drafts(target_path)
  WHERE status IN ('proposed', 'approved');
CREATE INDEX idx_context_drafts_status_updated
  ON context_drafts(status, updated_at);
CREATE INDEX idx_context_drafts_mission_updated
  ON context_drafts(mission_id, updated_at);
`;

/**
 * Aditivo (Fase A do mission driver): adiciona a coluna learnings à tabela
 * missions pré-existente. DEFAULT '' → missões antigas ficam vazias, nunca
 * NULL. Nunca edite o baseline INITIAL_PROJECT_SCHEMA (quebraria o checksum de
 * DBs já migrados) — sempre append de migration ALTER como esta.
 */
const MISSION_LEARNINGS_SCHEMA = `
ALTER TABLE missions ADD COLUMN learnings TEXT NOT NULL DEFAULT '';
`;

/**
 * Intent-first mission runtime: additive intent state + contract columns.
 * Default `legacy` preserves pre-migration behavior until inference/rewrite.
 * Never edit INITIAL_PROJECT_SCHEMA — append ALTER migrations only.
 */
const MISSION_INTENT_RUNTIME_SCHEMA = `
ALTER TABLE missions ADD COLUMN intent_state TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE missions ADD COLUMN intent_contract_json TEXT;
ALTER TABLE missions ADD COLUMN intent_version INTEGER NOT NULL DEFAULT 0
  CHECK (intent_version >= 0);
CREATE INDEX idx_missions_intent_state
  ON missions(intent_state, status, updated_at);
`;

/**
 * Semantic terminal command blocks + mission event journal (consumer cursor/ACK).
 * Complements event_ledger (hash chain) without replacing budgets or receipts.
 * Append-only tables; never edit past migrations.
 */
const MISSION_EVENTS_COMMAND_BLOCKS_SCHEMA = `
CREATE TABLE mission_events (
  sequence         INTEGER NOT NULL CHECK (sequence > 0),
  id               TEXT NOT NULL UNIQUE,
  mission_id       TEXT NOT NULL,
  run_id           TEXT NOT NULL,
  parent_run_id    TEXT,
  event_type       TEXT NOT NULL,
  payload_json     TEXT NOT NULL DEFAULT '{}',
  idempotency_key  TEXT NOT NULL,
  occurred_at      INTEGER NOT NULL CHECK (occurred_at >= 0),
  origin           TEXT NOT NULL,
  delivery_status  TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'delivered', 'acked', 'failed')),
  PRIMARY KEY (mission_id, sequence),
  UNIQUE (mission_id, idempotency_key),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE TABLE mission_event_cursors (
  consumer_id    TEXT NOT NULL,
  mission_id     TEXT NOT NULL,
  last_sequence  INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  updated_at     INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (consumer_id, mission_id),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE TABLE command_blocks (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  pane_id           TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  mission_id        TEXT,
  command           TEXT NOT NULL,
  cwd               TEXT NOT NULL,
  project_root      TEXT,
  shell             TEXT NOT NULL,
  git_branch        TEXT,
  started_at        INTEGER NOT NULL CHECK (started_at >= 0),
  ended_at          INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
  duration_ms       INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  exit_code         INTEGER,
  status            TEXT NOT NULL
    CHECK (status IN ('running', 'success', 'failed', 'cancelled', 'unknown')),
  output_start_seq  INTEGER CHECK (output_start_seq IS NULL OR output_start_seq >= 0),
  output_end_seq    INTEGER CHECK (output_end_seq IS NULL OR output_end_seq >= 0),
  redacted          INTEGER NOT NULL DEFAULT 0 CHECK (redacted IN (0, 1)),
  denylisted        INTEGER NOT NULL DEFAULT 0 CHECK (denylisted IN (0, 1)),
  secret_hits       INTEGER NOT NULL DEFAULT 0 CHECK (secret_hits >= 0),
  idempotency_key   TEXT NOT NULL UNIQUE,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL
);

CREATE INDEX idx_mission_events_run_seq
  ON mission_events(mission_id, run_id, sequence);
CREATE INDEX idx_mission_events_delivery
  ON mission_events(mission_id, delivery_status, sequence);
CREATE INDEX idx_command_blocks_project_started
  ON command_blocks(project_root, started_at DESC);
CREATE INDEX idx_command_blocks_cwd_started
  ON command_blocks(cwd, started_at DESC);
CREATE INDEX idx_command_blocks_branch_started
  ON command_blocks(git_branch, started_at DESC);
CREATE INDEX idx_command_blocks_session
  ON command_blocks(session_id, started_at DESC);

-- delivery_status remains mutable for ACK; core columns are append-only.
-- Deletes only via mission CASCADE (no direct app delete path).
CREATE TRIGGER mission_events_immutable_update
BEFORE UPDATE OF sequence, id, mission_id, run_id, parent_run_id, event_type,
  payload_json, idempotency_key, occurred_at, origin
ON mission_events
BEGIN
  SELECT RAISE(ABORT, 'mission events are append-only');
END;
`;

/**
 * Materialized command history used by the terminal command refinery.
 * The observation journal makes aggregation idempotent even after raw block
 * retention prunes `command_blocks`; stats never learn redacted commands.
 */
const COMMAND_REFINERY_SCHEMA = `
CREATE TABLE command_stats (
  cwd                TEXT NOT NULL,
  command            TEXT NOT NULL,
  cwd_project_root   TEXT,
  total_count        INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  success_count      INTEGER NOT NULL DEFAULT 0 CHECK (
    success_count >= 0 AND success_count <= total_count
  ),
  distinct_days      INTEGER NOT NULL DEFAULT 0 CHECK (distinct_days >= 0),
  last_day           INTEGER NOT NULL CHECK (last_day >= 0),
  first_used         INTEGER NOT NULL CHECK (first_used >= 0),
  last_used          INTEGER NOT NULL CHECK (last_used >= first_used),
  last_branch        TEXT,
  dismissed_count    INTEGER NOT NULL DEFAULT 0 CHECK (dismissed_count >= 0),
  last_dismissed_at  INTEGER CHECK (
    last_dismissed_at IS NULL OR last_dismissed_at >= 0
  ),
  last_decayed_at    INTEGER NOT NULL CHECK (last_decayed_at >= 0),
  PRIMARY KEY (cwd, command)
) WITHOUT ROWID;

CREATE TABLE command_stat_observations (
  observation_key  TEXT PRIMARY KEY,
  observed_at      INTEGER NOT NULL CHECK (observed_at >= 0)
) WITHOUT ROWID;

CREATE TABLE command_stat_days (
  cwd      TEXT NOT NULL,
  command  TEXT NOT NULL,
  day      INTEGER NOT NULL CHECK (day >= 0),
  PRIMARY KEY (cwd, command, day)
) WITHOUT ROWID;

CREATE INDEX idx_command_stats_command
  ON command_stats(command COLLATE NOCASE);
CREATE INDEX idx_command_stats_project
  ON command_stats(cwd_project_root, last_used DESC);
CREATE INDEX idx_command_stats_last_used
  ON command_stats(last_used DESC);
`;

/** Canonical, main-verified mission output rendered by the result inspector. */
const MISSION_RESULT_SCHEMA = `
ALTER TABLE missions ADD COLUMN result_json TEXT;
`;

/** Durable Ralph-loop budget plus immutable PREVC step receipts. */
const MISSION_DRIVER_RUNTIME_SCHEMA = `
CREATE TABLE mission_drive_state (
  mission_id            TEXT PRIMARY KEY,
  revision              INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  run_started_at        INTEGER NOT NULL CHECK (run_started_at >= 0),
  attempt_count         INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at       INTEGER CHECK (last_attempt_at IS NULL OR last_attempt_at >= 0),
  last_success_at       INTEGER CHECK (last_success_at IS NULL OR last_success_at >= 0),
  last_signal_at        INTEGER CHECK (last_signal_at IS NULL OR last_signal_at >= 0),
  last_action_kind      TEXT,
  last_outcome          TEXT CHECK (last_outcome IS NULL OR last_outcome IN ('reserved', 'success', 'failed')),
  last_error            TEXT,
  updated_at            INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE TABLE mission_step_receipts (
  mission_id               TEXT NOT NULL,
  step_id                  TEXT NOT NULL,
  from_stage               TEXT NOT NULL,
  to_stage                 TEXT NOT NULL,
  workflow_revision_before INTEGER NOT NULL CHECK (workflow_revision_before >= 1),
  workflow_revision_after  INTEGER NOT NULL CHECK (workflow_revision_after >= 1),
  evidence_ids_json        TEXT NOT NULL,
  evidence_binding_json    TEXT NOT NULL,
  completed_at             INTEGER NOT NULL CHECK (completed_at >= 0),
  PRIMARY KEY (mission_id, step_id),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE INDEX idx_mission_drive_attempt
  ON mission_drive_state(last_attempt_at, attempt_count);
CREATE INDEX idx_mission_step_receipt_revision
  ON mission_step_receipts(mission_id, workflow_revision_after);

CREATE TRIGGER mission_step_receipts_immutable
BEFORE UPDATE ON mission_step_receipts
BEGIN
  SELECT RAISE(ABORT, 'mission step receipts are immutable');
END;
`;

/**
 * F-234: veredito de integração por HEAD exato. Push/integração de uma missão
 * só roda com `approve` de modelo de ponta registrado contra o HEAD corrente e
 * árvore limpa — o registro leve vive aqui (a tabela `review_reports` é do
 * council PREVC, com binding por contractHash, e não se aplica à Via Rápida).
 */
const MISSION_REVIEW_VERDICTS_SCHEMA = `
CREATE TABLE mission_review_verdicts (
  verdict_id       TEXT PRIMARY KEY,
  mission_id       TEXT NOT NULL,
  head_sha         TEXT NOT NULL CHECK (length(head_sha) IN (40, 64)),
  tree_dirty       INTEGER NOT NULL CHECK (tree_dirty IN (0, 1)),
  verdict          TEXT NOT NULL CHECK (verdict IN ('approve', 'reject')),
  reviewer_adapter TEXT NOT NULL,
  reviewer_model   TEXT,
  reviewer_session TEXT,
  frontier         INTEGER NOT NULL CHECK (frontier IN (0, 1)),
  findings_json    TEXT NOT NULL DEFAULT '[]' CHECK (length(findings_json) <= 16384),
  summary          TEXT NOT NULL CHECK (length(summary) <= 2000),
  created_at       INTEGER NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE INDEX idx_mission_review_verdicts_head
  ON mission_review_verdicts(mission_id, head_sha, created_at);
`;

/**
 * F-773 (G4): laço de resultado da rota. O handoff passa a dizer QUEM entregou
 * (CLI e modelo da sessão física) e o que o Maestro fez com a entrega no ACK
 * (`accepted` | `rework`, F-782). Colunas novas são nulas: linha antiga fica
 * sem atribuição e simplesmente não entra na taxa. O índice parcial cobre a
 * consulta da janela de 14 dias sem ler `summary`/`artifacts_json` da linha.
 */
const HANDOFF_ROUTE_OUTCOME_SCHEMA = `
ALTER TABLE handoffs ADD COLUMN adapter_id TEXT;
ALTER TABLE handoffs ADD COLUMN model TEXT;
ALTER TABLE handoffs ADD COLUMN ack_verdict TEXT
  CHECK (ack_verdict IS NULL OR ack_verdict IN ('accepted', 'rework'));

CREATE INDEX idx_handoffs_route_outcome
  ON handoffs(created_at, adapter_id, model, status, ack_verdict, from_agent, session_id)
  WHERE adapter_id IS NOT NULL;
`;

/**
 * F-773 (G6): o log de decisões de rota (nexus_route_log) era só memória com
 * teto de 50 e voltava vazio a cada boot. A mesma linha agora persiste aqui;
 * a retenção (30 dias / 5.000 linhas) é aplicada na escrita.
 */
const ROUTE_DECISION_LOG_SCHEMA = `
CREATE TABLE route_decisions (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id        TEXT,
  task_preview      TEXT NOT NULL CHECK (length(task_preview) <= 120),
  tier              TEXT NOT NULL CHECK (length(tier) <= 32),
  adapter_id        TEXT NOT NULL CHECK (length(adapter_id) <= 128),
  model             TEXT CHECK (model IS NULL OR length(model) <= 256),
  effort            TEXT CHECK (effort IS NULL OR length(effort) <= 64),
  reason            TEXT NOT NULL CHECK (length(reason) <= 16384),
  classifier_source TEXT CHECK (classifier_source IS NULL OR length(classifier_source) <= 32),
  jev_unavailable   TEXT CHECK (jev_unavailable IS NULL OR length(jev_unavailable) <= 64),
  confidence_json   TEXT CHECK (confidence_json IS NULL OR length(confidence_json) <= 1024),
  rule_choice_json  TEXT CHECK (rule_choice_json IS NULL OR length(rule_choice_json) <= 1024),
  alternatives_json TEXT CHECK (alternatives_json IS NULL OR length(alternatives_json) <= 8192),
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE INDEX idx_route_decisions_created
  ON route_decisions(created_at);
`;

/**
 * ORC-01 + ORC-04 (um corte, política T3 @ 26285ab): outbox transacional de
 * efeitos com classe derivada do tipo (replay-safe × process-bound) e recibo
 * de comando com resultSequence. A decisão e a linha do outbox nascem na
 * MESMA transação; o worker assenta depois, sob lease.
 *
 * Reconcile de perda do processo (ORC-06):
 * - PROCESS_BOUND em pending/running → cancelled (não reexecuta).
 * - REPLAY_SAFE em running → pending (reentra).
 * Mesmo commandId não enfileira de novo — o segundo lê o recibo e a sequence
 * final. Primeiro corte: NÃO substitui handoff-delivery-outbox.
 */
const EFFECT_OUTBOX_COMMAND_RECEIPTS_SCHEMA = `
CREATE TABLE effect_outbox (
  effect_id         TEXT PRIMARY KEY,
  command_id        TEXT NOT NULL,
  thread_id         TEXT NOT NULL,
  effect_type       TEXT NOT NULL CHECK (length(effect_type) BETWEEN 1 AND 64),
  payload_json      TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at      INTEGER NOT NULL CHECK (available_at >= 0),
  lease_owner       TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 128),
  lease_expires_at  INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  created_at        INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at        INTEGER NOT NULL CHECK (updated_at >= 0),
  completed_at      INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
  last_error        TEXT CHECK (last_error IS NULL OR length(last_error) <= 512)
);

CREATE INDEX idx_effect_outbox_claimable
  ON effect_outbox(status, available_at, created_at);
CREATE INDEX idx_effect_outbox_thread
  ON effect_outbox(thread_id, status, created_at);
CREATE INDEX idx_effect_outbox_command
  ON effect_outbox(command_id);

CREATE TABLE command_receipts (
  command_id        TEXT PRIMARY KEY,
  aggregate_kind    TEXT NOT NULL CHECK (aggregate_kind IN ('thread', 'project')),
  aggregate_id      TEXT NOT NULL,
  command_type      TEXT NOT NULL CHECK (length(command_type) BETWEEN 1 AND 128),
  accepted_at       INTEGER NOT NULL CHECK (accepted_at >= 0),
  result_sequence   INTEGER NOT NULL DEFAULT 0 CHECK (result_sequence >= 0),
  status            TEXT NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'rejected')),
  error             TEXT CHECK (error IS NULL OR length(error) <= 512),
  effect_class      TEXT NOT NULL
    CHECK (effect_class IN ('process_bound', 'replay_safe'))
);

CREATE INDEX idx_command_receipts_aggregate
  ON command_receipts(aggregate_kind, aggregate_id, accepted_at);
CREATE INDEX idx_command_receipts_unsettled
  ON command_receipts(result_sequence) WHERE result_sequence = 0;
`;

export const INITIAL_PROJECT_MIGRATIONS: readonly ProjectMigration[] =
  validateProjectMigrations([
    createProjectMigration({
      id: '001-initial-project-schema',
      schemaVersion: 1,
      appVersion: '0.12.0',
      sql: INITIAL_PROJECT_SCHEMA,
    }),
    createProjectMigration({
      id: '002-scoped-ui-domain-stores',
      schemaVersion: 2,
      appVersion: '0.12.0',
      sql: SCOPED_UI_DOMAIN_SCHEMA,
    }),
    createProjectMigration({
      id: '003-scoped-gamification-store',
      schemaVersion: 3,
      appVersion: '0.12.0',
      sql: SCOPED_GAMIFICATION_SCHEMA,
    }),
    createProjectMigration({
      id: '004-context-workflow-runtime',
      schemaVersion: 4,
      appVersion: '0.12.0',
      sql: CONTEXT_WORKFLOW_RUNTIME_SCHEMA,
    }),
    createProjectMigration({
      id: '005-scoped-voice-transcripts',
      schemaVersion: 5,
      appVersion: '0.12.0',
      sql: SCOPED_VOICE_TRANSCRIPTS_SCHEMA,
    }),
    createProjectMigration({
      id: '006-scoped-cron-execution-state',
      schemaVersion: 6,
      appVersion: '0.12.0',
      sql: SCOPED_CRON_EXECUTION_STATE_SCHEMA,
    }),
    createProjectMigration({
      id: '007-context-draft-attestations',
      schemaVersion: 7,
      appVersion: '0.12.0',
      sql: CONTEXT_DRAFT_ATTESTATION_SCHEMA,
    }),
    createProjectMigration({
      id: '008-trusted-handoff-evidence',
      schemaVersion: 8,
      appVersion: '0.12.0',
      sql: TRUSTED_HANDOFF_EVIDENCE_SCHEMA,
    }),
    createProjectMigration({
      id: '009-handoff-delivery-receipts',
      schemaVersion: 9,
      appVersion: '0.14.4',
      sql: HANDOFF_DELIVERY_RECEIPTS_SCHEMA,
    }),
    createProjectMigration({
      id: '010-context-draft-supersession',
      schemaVersion: 10,
      appVersion: '0.15.1',
      sql: CONTEXT_DRAFT_SUPERSESSION_SCHEMA,
    }),
    createProjectMigration({
      id: '011-mission-learnings',
      schemaVersion: 11,
      appVersion: '0.15.2',
      sql: MISSION_LEARNINGS_SCHEMA,
    }),
    createProjectMigration({
      id: '012-mission-driver-runtime',
      schemaVersion: 12,
      appVersion: '0.15.3',
      sql: MISSION_DRIVER_RUNTIME_SCHEMA,
    }),
    createProjectMigration({
      id: '013-mission-intent-runtime',
      schemaVersion: 13,
      appVersion: '0.15.5',
      sql: MISSION_INTENT_RUNTIME_SCHEMA,
    }),
    createProjectMigration({
      id: '014-mission-events-command-blocks',
      schemaVersion: 14,
      appVersion: '0.15.5',
      sql: MISSION_EVENTS_COMMAND_BLOCKS_SCHEMA,
    }),
    ...ORCHESTRATION_PROJECT_MIGRATION_SPECS.map((spec) =>
      createProjectMigration(spec),
    ),
    createProjectMigration({
      id: '036-command-refinery',
      schemaVersion: 36,
      appVersion: '0.28.0',
      sql: COMMAND_REFINERY_SCHEMA,
    }),
    createProjectMigration({
      id: '037-mission-result',
      schemaVersion: 37,
      appVersion: '0.28.1',
      sql: MISSION_RESULT_SCHEMA,
    }),
    // F-239: rodadas de handoff — identidade idempotente do recibo passa a ser
    // (logical_operation_key, raw_payload_sha256).
    createProjectMigration({
      id: '038-handoff-rounded-operation-identity',
      schemaVersion: 38,
      appVersion: '0.76.154',
      sql: HANDOFF_ROUNDED_OPERATION_IDENTITY_SCHEMA,
    }),
    // F-234: "código só integra/push após veredito de modelo de ponta" —
    // registro durável do veredito, atado ao HEAD exato do checkout.
    createProjectMigration({
      id: '039-mission-review-verdicts',
      schemaVersion: 39,
      appVersion: '0.76.154',
      sql: MISSION_REVIEW_VERDICTS_SCHEMA,
    }),
    // F-231: "+ Pane" dentro de missão — pane do operador participante nunca
    // é morto pelo fim da missão (TTL, teardown, mortalidade).
    createProjectMigration({
      id: '040-mission-pane-operator-opened',
      schemaVersion: 40,
      appVersion: '0.76.154',
      sql: `ALTER TABLE mission_panes
            ADD COLUMN operator_opened INTEGER NOT NULL DEFAULT 0
            CHECK(operator_opened IN (0,1))`,
    }),
    // F-773 (G4): quem entregou cada handoff e o veredito do Maestro — a
    // taxa de sucesso real por (CLI, modelo) que entra na nota da rota.
    createProjectMigration({
      id: '041-handoff-route-outcome',
      schemaVersion: 41,
      appVersion: '0.76.191',
      sql: HANDOFF_ROUTE_OUTCOME_SCHEMA,
    }),
    // F-773 (G6): o log de rota sobrevive ao restart ("por que X perdeu").
    createProjectMigration({
      id: '042-route-decision-log',
      schemaVersion: 42,
      appVersion: '0.76.191',
      sql: ROUTE_DECISION_LOG_SCHEMA,
    }),
    // F-764: task-scoped mutation identity survives same-clock status ABA,
    // other store facades and deletion/recreation of the same task id.
    createProjectMigration({
      id: '043-task-mutation-versions',
      schemaVersion: 43,
      appVersion: '0.76.191',
      sql: `
CREATE TABLE task_mutation_versions (
  task_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision > 0)
);
INSERT INTO task_mutation_versions(task_id, revision) SELECT id, 1 FROM tasks;
CREATE TRIGGER task_mutation_insert AFTER INSERT ON tasks BEGIN
  INSERT INTO task_mutation_versions(task_id, revision) VALUES (NEW.id, 1)
  ON CONFLICT(task_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER task_mutation_update AFTER UPDATE ON tasks BEGIN
  INSERT INTO task_mutation_versions(task_id, revision) VALUES (OLD.id, 1)
  ON CONFLICT(task_id) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER task_mutation_delete AFTER DELETE ON tasks BEGIN
  INSERT INTO task_mutation_versions(task_id, revision) VALUES (OLD.id, 1)
  ON CONFLICT(task_id) DO UPDATE SET revision = revision + 1;
END;`,
    }),
    createProjectMigration({
      id: '044-memory-handoff-dispatch-index',
      schemaVersion: 44,
      appVersion: '0.76.191',
      sql: `CREATE INDEX idx_task_dispatch_queue_handoff_memory
        ON task_dispatch_queue(handoff_id) WHERE handoff_id IS NOT NULL;`,
    }),
    createProjectMigration({
      id: '045-visual-handoff-evidence',
      schemaVersion: 45,
      appVersion: '0.76.191',
      sql: `CREATE TABLE visual_handoff_evidence (
        artifact_id TEXT PRIMARY KEY REFERENCES browser_artifacts(id) ON DELETE CASCADE,
        mission_id TEXT,
        session_id TEXT NOT NULL,
        worker_incarnation_id TEXT,
        execution_root TEXT NOT NULL,
        captured_at INTEGER NOT NULL
      );
      CREATE INDEX idx_visual_handoff_worker ON visual_handoff_evidence
        (session_id, mission_id, worker_incarnation_id, execution_root, captured_at DESC);`,
    }),
    createProjectMigration({
      id: '046-visual-assignment-identity', schemaVersion: 46, appVersion: '0.76.191',
      sql: `ALTER TABLE visual_handoff_evidence ADD COLUMN assignment_id TEXT NOT NULL DEFAULT '';
      CREATE INDEX idx_visual_handoff_assignment ON visual_handoff_evidence
        (session_id, mission_id, worker_incarnation_id, execution_root, assignment_id, captured_at DESC);`,
    }),
    // F-808/F-911: autoridade readOnly Main-owned da sessão autora, gravada no
    // submit (NULL = não provada → quarentena fail-safe na memória).
    createProjectMigration({
      id: '047-handoff-author-read-only', schemaVersion: 47, appVersion: '0.76.192',
      sql: `ALTER TABLE handoffs ADD COLUMN author_read_only INTEGER
        CHECK (author_read_only IS NULL OR author_read_only IN (0, 1));`,
    }),
    // ORC-01+ORC-04 (corte T3): outbox transacional de efeitos com classe
    // replay-safe × process-bound + recibo de comando com resultSequence.
    // Não substitui handoff-delivery-outbox neste corte.
    createProjectMigration({
      id: '048-effect-outbox-command-receipts',
      schemaVersion: 48,
      appVersion: '0.76.212',
      sql: EFFECT_OUTBOX_COMMAND_RECEIPTS_SCHEMA,
    }),
    // Resultado do despacho para o retry da mesma operação. Não muda a
    // sequence: sequence 0 continua sendo "o efeito ainda não assentou".
    createProjectMigration({
      id: '049-command-receipt-dispatch-outcome',
      schemaVersion: 49,
      appVersion: '0.76.212',
      sql: `ALTER TABLE command_receipts ADD COLUMN outcome_json TEXT
        CHECK (outcome_json IS NULL OR length(outcome_json) <= 32768);`,
    }),
    // Invalidate legacy raw result replay without loading any result bodies.
    createProjectMigration({
      id: '050-safe-command-response-projection',
      schemaVersion: 50,
      appVersion: '0.76.213',
      sql: `UPDATE command_receipts SET outcome_json = NULL
        WHERE outcome_json IS NOT NULL;`,
    }),
    createProjectMigration({
      id: '051-command-dispatch-identity', schemaVersion: 51, appVersion: '0.76.213',
      sql: `ALTER TABLE command_receipts ADD COLUMN binding_digest TEXT
        CHECK (binding_digest IS NULL OR length(binding_digest) = 64);`,
    }),
    createProjectMigration({
      id: '052-command-dispatch-settlement-events', schemaVersion: 52, appVersion: '0.76.213',
      sql: `ALTER TABLE command_receipts ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'unknown'
          CHECK(dispatch_state IN ('admitted','observed-success','observed-rejection','unknown','settled'));
        ALTER TABLE command_receipts ADD COLUMN physical_state TEXT NOT NULL DEFAULT 'none'
          CHECK(physical_state IN ('none','pending','proven','unknown'));
        ALTER TABLE command_receipts ADD COLUMN generated_invocation INTEGER NOT NULL DEFAULT 0 CHECK(generated_invocation IN(0,1));
        CREATE TABLE command_dispatch_events(
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          command_id TEXT NOT NULL REFERENCES command_receipts(command_id) ON DELETE CASCADE,
          event_kind TEXT NOT NULL CHECK(event_kind IN('admitted','response','physical-start','physical-proven','physical-unknown','settled')),
          occurred_at INTEGER NOT NULL, response_kind TEXT, physical_state TEXT NOT NULL,
          UNIQUE(command_id,event_kind));
        CREATE INDEX command_receipts_unsettled ON command_receipts(result_sequence,accepted_at,command_id);`,
    }),
  ]);
