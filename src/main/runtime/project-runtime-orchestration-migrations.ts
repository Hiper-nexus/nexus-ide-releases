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

/**
 * A direct `ScopedHandoffStore.submit` remains valid untrusted delivery
 * metadata, but cannot impersonate a physical MCP tool invocation. Only the
 * handoff tool boundary inserts this one-to-one receipt in the same
 * transaction as the handoff row.
 */
const HANDOFF_MCP_PROVENANCE_SCHEMA = `
CREATE TABLE handoff_mcp_receipts (
  receipt_id             TEXT PRIMARY KEY,
  handoff_id             TEXT NOT NULL UNIQUE,
  tool_call_id           TEXT NOT NULL UNIQUE,
  tool_name              TEXT NOT NULL CHECK (tool_name = 'nexus_handoff_submit'),
  source                 TEXT NOT NULL CHECK (
    source IN ('http-mcp', 'omp-rpc-stdio')
  ),
  mission_id             TEXT NOT NULL,
  session_id             TEXT NOT NULL,
  worker_incarnation_id  TEXT,
  authority_sha256       TEXT NOT NULL CHECK (length(authority_sha256) = 64),
  worktree_head_sha      TEXT CHECK (
    worktree_head_sha IS NULL OR length(worktree_head_sha) IN (40, 64)
  ),
  issued_at              INTEGER NOT NULL CHECK (issued_at >= 0),
  FOREIGN KEY (handoff_id) REFERENCES handoffs(id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE INDEX idx_handoff_mcp_receipts_worker
  ON handoff_mcp_receipts(
    mission_id, session_id, worker_incarnation_id, issued_at
  );

CREATE TRIGGER handoff_mcp_receipt_immutable
BEFORE UPDATE ON handoff_mcp_receipts
BEGIN
  SELECT RAISE(ABORT, 'handoff MCP receipt is immutable');
END;
`;

/**
 * Physical handoff retries are keyed independently from their payload. This
 * makes a divergent retry collide with the original logical operation while
 * retaining the full pre-compaction argument digest for exact comparison.
 *
 * Columns stay nullable only for migration compatibility. Current physical
 * writes require both values and replay of a legacy row fails closed because
 * the immutable v21 receipt cannot be safely backfilled.
 */
const HANDOFF_IDEMPOTENCY_IDENTITY_SCHEMA = `
ALTER TABLE handoff_mcp_receipts ADD COLUMN raw_payload_sha256 TEXT
  CHECK (raw_payload_sha256 IS NULL OR length(raw_payload_sha256) = 64);
ALTER TABLE handoff_mcp_receipts ADD COLUMN logical_operation_key TEXT
  CHECK (logical_operation_key IS NULL OR length(logical_operation_key) = 64);

CREATE UNIQUE INDEX idx_handoff_mcp_receipts_logical_operation
  ON handoff_mcp_receipts(logical_operation_key)
  WHERE logical_operation_key IS NOT NULL;
`;

/**
 * AGY 1.1 and other CLIs without a physically usable private MCP config finish
 * through a Main-observed PTY marker. Preserve the historical table name for
 * compatibility, but widen its immutable transport source to `pty-stream`.
 * Rebuilding is required because SQLite cannot alter a CHECK constraint.
 */
const HANDOFF_PTY_STREAM_PROVENANCE_SCHEMA = `
DROP TRIGGER IF EXISTS handoff_mcp_receipt_immutable;

ALTER TABLE handoff_mcp_receipts
  RENAME TO handoff_physical_receipts_v24;

CREATE TABLE handoff_mcp_receipts (
  receipt_id             TEXT PRIMARY KEY,
  handoff_id             TEXT NOT NULL UNIQUE,
  tool_call_id           TEXT NOT NULL UNIQUE,
  tool_name              TEXT NOT NULL CHECK (tool_name = 'nexus_handoff_submit'),
  source                 TEXT NOT NULL CHECK (
    source IN ('http-mcp', 'pty-stream', 'omp-rpc-stdio')
  ),
  mission_id             TEXT NOT NULL,
  session_id             TEXT NOT NULL,
  worker_incarnation_id  TEXT,
  authority_sha256       TEXT NOT NULL CHECK (length(authority_sha256) = 64),
  worktree_head_sha      TEXT CHECK (
    worktree_head_sha IS NULL OR length(worktree_head_sha) IN (40, 64)
  ),
  issued_at              INTEGER NOT NULL CHECK (issued_at >= 0),
  raw_payload_sha256     TEXT CHECK (
    raw_payload_sha256 IS NULL OR length(raw_payload_sha256) = 64
  ),
  logical_operation_key  TEXT CHECK (
    logical_operation_key IS NULL OR length(logical_operation_key) = 64
  ),
  FOREIGN KEY (handoff_id) REFERENCES handoffs(id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

INSERT INTO handoff_mcp_receipts (
  receipt_id, handoff_id, tool_call_id, tool_name, source,
  mission_id, session_id, worker_incarnation_id, authority_sha256,
  worktree_head_sha, issued_at, raw_payload_sha256, logical_operation_key
)
SELECT
  receipt_id, handoff_id, tool_call_id, tool_name, source,
  mission_id, session_id, worker_incarnation_id, authority_sha256,
  worktree_head_sha, issued_at, raw_payload_sha256, logical_operation_key
FROM handoff_physical_receipts_v24;

DROP TABLE handoff_physical_receipts_v24;

CREATE INDEX idx_handoff_mcp_receipts_worker
  ON handoff_mcp_receipts(
    mission_id, session_id, worker_incarnation_id, issued_at
  );

CREATE UNIQUE INDEX idx_handoff_mcp_receipts_logical_operation
  ON handoff_mcp_receipts(logical_operation_key)
  WHERE logical_operation_key IS NOT NULL;

CREATE TRIGGER handoff_mcp_receipt_immutable
BEFORE UPDATE ON handoff_mcp_receipts
BEGIN
  SELECT RAISE(ABORT, 'handoff physical receipt is immutable');
END;
`;

/**
 * Consumption is stronger than transport delivery:
 *
 * - a terminal/orchestrator ACK is bound to the exact accepted delivery
 *   attempt and physical orchestrator session;
 * - every sealed dependency edge gets an immutable receipt only after the
 *   downstream worker accepted the prompt containing that handoff result.
 *
 * The nullable handoff columns preserve old audit rows. Current completion
 * authority is fail-closed and requires these bindings for new completions.
 */
const HANDOFF_RESULT_CONSUMPTION_SCHEMA = `
ALTER TABLE handoffs ADD COLUMN consumed_by_session TEXT;
ALTER TABLE handoffs ADD COLUMN consumed_delivery_attempt_id TEXT;

CREATE TABLE task_dependency_consumption_receipts (
  mission_id                     TEXT NOT NULL,
  consumer_task_id               TEXT NOT NULL,
  dependency_task_id             TEXT NOT NULL,
  handoff_id                     TEXT NOT NULL,
  consumer_session_id            TEXT NOT NULL,
  consumer_worker_incarnation_id TEXT NOT NULL,
  prompt_sha256                  TEXT NOT NULL CHECK (length(prompt_sha256) = 64),
  handoff_summary_sha256         TEXT NOT NULL CHECK (length(handoff_summary_sha256) = 64),
  consumed_at                    INTEGER NOT NULL CHECK (consumed_at >= 0),
  PRIMARY KEY (consumer_task_id, dependency_task_id),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
  FOREIGN KEY (consumer_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (dependency_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (handoff_id) REFERENCES handoffs(id) ON DELETE CASCADE
);

CREATE INDEX idx_task_dependency_consumption_mission
  ON task_dependency_consumption_receipts(
    mission_id, consumer_task_id, consumed_at
  );

CREATE TRIGGER task_dependency_consumption_immutable
BEFORE UPDATE ON task_dependency_consumption_receipts
BEGIN
  SELECT RAISE(ABORT, 'task dependency consumption receipt is immutable');
END;
`;

/**
 * Invalid legacy worktree rows cannot be silently discarded: they may still
 * describe an unmerged checkout containing user work. Recovery therefore
 * copies the exact worktree and merge payloads into an immutable audit row
 * before it resets only the scoped coordinator projection. No Git path or ref
 * is removed by this migration or by the recovery transaction.
 */
const WORKTREE_STATE_QUARANTINE_SCHEMA = `
CREATE TABLE worktree_state_quarantine (
  id                    TEXT PRIMARY KEY CHECK (length(id) = 64),
  scope_key             TEXT NOT NULL,
  source_revision       INTEGER NOT NULL CHECK (source_revision >= 0),
  source_records_json   TEXT NOT NULL,
  source_updated_at     INTEGER NOT NULL CHECK (source_updated_at >= 0),
  merge_revision        INTEGER CHECK (
    merge_revision IS NULL OR merge_revision >= 0
  ),
  merge_state_json      TEXT,
  merge_updated_at      INTEGER CHECK (
    merge_updated_at IS NULL OR merge_updated_at >= 0
  ),
  reason                TEXT NOT NULL CHECK (
    reason IN ('relocated-runtime-binding', 'terminal-legacy-state')
  ),
  quarantined_at        INTEGER NOT NULL CHECK (quarantined_at >= 0),
  CHECK (
    (merge_revision IS NULL AND merge_state_json IS NULL AND merge_updated_at IS NULL)
    OR
    (merge_revision IS NOT NULL AND merge_state_json IS NOT NULL AND merge_updated_at IS NOT NULL)
  )
);

CREATE INDEX idx_worktree_state_quarantine_scope
  ON worktree_state_quarantine(scope_key, quarantined_at);

CREATE TRIGGER worktree_state_quarantine_immutable_update
BEFORE UPDATE ON worktree_state_quarantine
BEGIN
  SELECT RAISE(ABORT, 'worktree state quarantine records are immutable');
END;

CREATE TRIGGER worktree_state_quarantine_immutable_delete
BEFORE DELETE ON worktree_state_quarantine
BEGIN
  SELECT RAISE(ABORT, 'worktree state quarantine records are immutable');
END;
`;

export const ORCHESTRATION_PROJECT_MIGRATION_SPECS: readonly ProjectMigrationSpec[] =
  [
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
    {
      id: '021-handoff-mcp-provenance',
      schemaVersion: 21,
      appVersion: '0.19.31',
      sql: HANDOFF_MCP_PROVENANCE_SCHEMA,
    },
    {
      id: '022-handoff-result-consumption',
      schemaVersion: 22,
      appVersion: '0.19.31',
      sql: HANDOFF_RESULT_CONSUMPTION_SCHEMA,
    },
    {
      id: '023-worktree-state-quarantine',
      schemaVersion: 23,
      appVersion: '0.19.31',
      sql: WORKTREE_STATE_QUARANTINE_SCHEMA,
    },
    {
      id: '024-handoff-idempotency-identity',
      schemaVersion: 24,
      appVersion: '0.19.31',
      sql: HANDOFF_IDEMPOTENCY_IDENTITY_SCHEMA,
    },
    {
      id: '025-handoff-pty-stream-provenance',
      schemaVersion: 25,
      appVersion: '0.19.37',
      sql: HANDOFF_PTY_STREAM_PROVENANCE_SCHEMA,
    },
  ];
