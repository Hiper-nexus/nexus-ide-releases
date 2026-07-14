import { createHash } from 'node:crypto';

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
 * hashes and a provider-independent reviewer. Applied authority is portable
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
  ]);
