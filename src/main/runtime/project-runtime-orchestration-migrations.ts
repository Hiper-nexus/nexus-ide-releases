import type { ProjectMigrationSpec } from './project-runtime-schema';

/**
 * Mission-scoped route reservations. A route decision is durable, expires,
 * and is consumed once so pane_spawn cannot substitute an arbitrary provider
 * after nexus_route_task returns.
 */
const MISSION_ROUTE_RESERVATIONS_SCHEMA = `
CREATE TABLE mission_route_reservations (
  id                    TEXT PRIMARY KEY,
  mission_id            TEXT NOT NULL,
  intent_version        INTEGER NOT NULL CHECK (intent_version >= 0),
  task_preview          TEXT NOT NULL,
  decision_json         TEXT NOT NULL,
  adapter_id            TEXT NOT NULL,
  model                 TEXT,
  effort                TEXT,
  created_at            INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at            INTEGER NOT NULL CHECK (expires_at >= created_at),
  consumed_at           INTEGER CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  consumed_by_session   TEXT,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE INDEX idx_mission_route_reservations_pending
  ON mission_route_reservations(mission_id, consumed_at, expires_at);
`;

/**
 * Durable, fenced authority for task dispatch. The task row is changed to
 * running in the same SQLite IMMEDIATE transaction that creates a claim, so
 * two scheduler ticks/restarts cannot both reach the spawn side effect.
 */
const TASK_DISPATCH_QUEUE_SCHEMA = `
CREATE TABLE mission_task_plans (
  mission_id       TEXT NOT NULL,
  intent_version   INTEGER NOT NULL CHECK (intent_version >= 0),
  plan_hash        TEXT NOT NULL,
  planner_json     TEXT NOT NULL,
  created_at       INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (mission_id, intent_version),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE TABLE task_dispatch_queue (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL UNIQUE,
  mission_id            TEXT NOT NULL,
  intent_version        INTEGER NOT NULL CHECK (intent_version >= 0),
  revision              INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  attempt               INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  state                 TEXT NOT NULL CHECK (state IN (
    'claimed', 'routed', 'spawning', 'running', 'handoff_ready',
    'merging', 'completed', 'blocked', 'failed', 'suspended', 'superseded'
  )),
  lease_token_hash      TEXT NOT NULL,
  lease_owner           TEXT NOT NULL,
  lease_expires_at      INTEGER NOT NULL CHECK (lease_expires_at >= 0),
  route_reservation_id  TEXT,
  adapter_id            TEXT,
  model                 TEXT,
  effort                TEXT,
  worker_id             TEXT NOT NULL,
  ownership_json        TEXT NOT NULL DEFAULT '{"files":[],"symbols":[],"domains":[]}',
  execution_mode        TEXT NOT NULL DEFAULT 'isolated_worktree' CHECK (
    execution_mode IN ('isolated_worktree', 'same_checkout', 'read_only')
  ),
  pane_id               TEXT,
  session_id            TEXT,
  handoff_id            TEXT,
  handoff_accepted_at   INTEGER CHECK (
    handoff_accepted_at IS NULL OR handoff_accepted_at >= 0
  ),
  integration_receipt_json TEXT,
  completed_at          INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
  last_heartbeat_at     INTEGER,
  last_error            TEXT,
  created_at            INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at            INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
  FOREIGN KEY (route_reservation_id)
    REFERENCES mission_route_reservations(id) ON DELETE SET NULL,
  FOREIGN KEY (handoff_id) REFERENCES handoffs(id) ON DELETE SET NULL
);

CREATE INDEX idx_task_dispatch_queue_mission_state
  ON task_dispatch_queue(mission_id, state, lease_expires_at);
CREATE UNIQUE INDEX idx_task_dispatch_queue_active_session
  ON task_dispatch_queue(session_id)
  WHERE session_id IS NOT NULL AND state IN (
    'spawning', 'running', 'handoff_ready', 'merging'
  );

CREATE TABLE handoff_delivery_attempts (
  id                       TEXT PRIMARY KEY,
  handoff_id               TEXT NOT NULL,
  mission_id               TEXT NOT NULL,
  orchestrator_session_id  TEXT NOT NULL,
  attempt_no               INTEGER NOT NULL CHECK (attempt_no >= 1),
  state                    TEXT NOT NULL CHECK (
    state IN ('reserved', 'pasted', 'accepted', 'failed')
  ),
  started_at               INTEGER NOT NULL CHECK (started_at >= 0),
  accept_deadline_at       INTEGER,
  accepted_at              INTEGER,
  failed_at                INTEGER,
  failure_code             TEXT,
  UNIQUE (handoff_id, attempt_no),
  FOREIGN KEY (handoff_id) REFERENCES handoffs(id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_handoff_delivery_attempt_active
  ON handoff_delivery_attempts(handoff_id)
  WHERE state IN ('reserved', 'pasted');
CREATE INDEX idx_handoff_delivery_attempt_session
  ON handoff_delivery_attempts(orchestrator_session_id, state, started_at);
`;

/**
 * Seals every planned task to the exact squad roster that authorized it.
 * Columns are nullable at the SQLite layer because migration 017 must preserve
 * databases that may already contain pre-contract rows from migration 016.
 * New task-plan/dispatch writes enforce presence and integrity in their stores.
 */
const TASK_PLAN_ROSTER_CONTRACT_SCHEMA = `
ALTER TABLE mission_task_plans ADD COLUMN squad_id TEXT;
ALTER TABLE mission_task_plans ADD COLUMN roster_hash TEXT;
ALTER TABLE mission_task_plans ADD COLUMN roster_snapshot_json TEXT;

ALTER TABLE task_dispatch_queue ADD COLUMN agent_ref TEXT;
ALTER TABLE task_dispatch_queue ADD COLUMN agent_category TEXT;
ALTER TABLE task_dispatch_queue ADD COLUMN roster_hash TEXT;
ALTER TABLE task_dispatch_queue ADD COLUMN route_contract_json TEXT;

CREATE INDEX idx_mission_task_plans_squad
  ON mission_task_plans(squad_id, roster_hash);
CREATE INDEX idx_task_dispatch_queue_agent
  ON task_dispatch_queue(mission_id, agent_ref, state);
`;

/**
 * Fences every physical worker process incarnation. Session ids remain useful
 * transport coordinates, but they are not generation tokens: a delayed
 * request from a previous pane must not renew or complete a reassigned task.
 * Nullable columns preserve pre-018 rows; current stores refuse to adopt those
 * rows as a live worker and let lifecycle reconciliation block them honestly.
 */
const WORKER_INCARNATION_FENCE_SCHEMA = `
ALTER TABLE task_dispatch_queue ADD COLUMN worker_incarnation_id TEXT;
ALTER TABLE handoffs ADD COLUMN worker_incarnation_id TEXT;

CREATE INDEX idx_task_dispatch_queue_incarnation
  ON task_dispatch_queue(worker_incarnation_id, session_id, state);
CREATE INDEX idx_handoffs_worker_incarnation
  ON handoffs(worker_incarnation_id, session_id, created_at);
`;

/**
 * Main-owned proof that one exact approved mission revision and physical
 * orchestrator session observed the kickoff idle→busy edge. Scheduler recovery
 * can trust this after restart without letting a rebind inherit stale proof.
 */
const MISSION_KICKOFF_ACCEPTANCE_SCHEMA = `
CREATE TABLE mission_kickoff_acceptances (
  mission_id                TEXT NOT NULL,
  intent_version            INTEGER NOT NULL CHECK (intent_version >= 0),
  orchestrator_session_id   TEXT NOT NULL,
  prompt_hash               TEXT NOT NULL CHECK (length(prompt_hash) = 64),
  accepted_at               INTEGER NOT NULL CHECK (accepted_at >= 0),
  PRIMARY KEY (mission_id, intent_version, orchestrator_session_id),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);
`;

/**
 * Durable provenance for instructions attributed to the human operator.
 * Ordinary agent/MCP submissions always retain the default `agent`; only the
 * native-confirmation main boundary may use the dedicated store method that
 * writes `operator-confirmed`.
 */
const HANDOFF_AUTHORITY_ORIGIN_SCHEMA = `
ALTER TABLE handoffs ADD COLUMN authority_origin TEXT NOT NULL DEFAULT 'agent'
  CHECK (authority_origin IN ('agent', 'operator-confirmed'));

CREATE INDEX idx_handoffs_authority_origin
  ON handoffs(mission_id, authority_origin, created_at);
`;

export const ORCHESTRATION_PROJECT_MIGRATION_SPECS: readonly ProjectMigrationSpec[] = [
    {
      id: '015-mission-route-reservations',
      schemaVersion: 15,
      appVersion: '0.19.27',
      sql: MISSION_ROUTE_RESERVATIONS_SCHEMA,
    },
    {
      id: '016-task-dispatch-queue',
      schemaVersion: 16,
      appVersion: '0.19.27',
      sql: TASK_DISPATCH_QUEUE_SCHEMA,
    },
    {
      id: '017-task-plan-roster-contract',
      schemaVersion: 17,
      appVersion: '0.19.27',
      sql: TASK_PLAN_ROSTER_CONTRACT_SCHEMA,
    },
    {
      id: '018-worker-incarnation-fence',
      schemaVersion: 18,
      appVersion: '0.19.27',
      sql: WORKER_INCARNATION_FENCE_SCHEMA,
    },
    {
      id: '019-mission-kickoff-acceptance',
      schemaVersion: 19,
      appVersion: '0.19.27',
      sql: MISSION_KICKOFF_ACCEPTANCE_SCHEMA,
    },
    {
      id: '020-handoff-authority-origin',
      schemaVersion: 20,
      appVersion: '0.19.27',
      sql: HANDOFF_AUTHORITY_ORIGIN_SCHEMA,
    },
];
