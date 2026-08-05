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

/**
 * Transport acceptance, explicit result consumption and final synthesis are
 * three different facts. These immutable receipts bind the latter two to the
 * exact physical Maestro tool calls and keep the final fan-out output durable
 * before mission completion can retire any runtime.
 */
const FANOUT_PHYSICAL_COMPLETION_PROOF_SCHEMA = `
CREATE TABLE handoff_ack_receipts (
  receipt_id              TEXT PRIMARY KEY,
  handoff_id              TEXT NOT NULL,
  delivery_attempt_id     TEXT NOT NULL UNIQUE,
  tool_call_id            TEXT NOT NULL UNIQUE,
  tool_name               TEXT NOT NULL CHECK (tool_name = 'nexus_handoff_ack'),
  source                  TEXT NOT NULL CHECK (source IN ('http-mcp', 'pty-stream')),
  mission_id              TEXT NOT NULL,
  orchestrator_session_id TEXT NOT NULL,
  authority_sha256        TEXT NOT NULL CHECK (length(authority_sha256) = 64),
  payload_sha256          TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  issued_at               INTEGER NOT NULL CHECK (issued_at >= 0),
  acknowledged_at         INTEGER NOT NULL CHECK (acknowledged_at >= issued_at),
  CHECK (receipt_id = tool_call_id),
  FOREIGN KEY (handoff_id) REFERENCES handoffs(id) ON DELETE CASCADE,
  FOREIGN KEY (delivery_attempt_id)
    REFERENCES handoff_delivery_attempts(id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE INDEX idx_handoff_ack_receipts_mission
  ON handoff_ack_receipts(mission_id, orchestrator_session_id, acknowledged_at);

CREATE INDEX idx_handoff_ack_receipts_handoff
  ON handoff_ack_receipts(handoff_id, orchestrator_session_id, acknowledged_at);

CREATE TRIGGER handoff_ack_receipts_immutable
BEFORE UPDATE ON handoff_ack_receipts
BEGIN
  SELECT RAISE(ABORT, 'handoff ACK receipt is immutable');
END;

CREATE TABLE mission_fanout_consolidation_receipts (
  mission_id              TEXT NOT NULL,
  intent_version          INTEGER NOT NULL CHECK (intent_version >= 0),
  plan_hash               TEXT NOT NULL CHECK (length(plan_hash) = 64),
  topology                TEXT NOT NULL CHECK (topology = 'team-read-only-fanout'),
  orchestrator_session_id TEXT NOT NULL,
  receipt_id              TEXT NOT NULL UNIQUE,
  tool_call_id            TEXT NOT NULL UNIQUE,
  tool_name               TEXT NOT NULL CHECK (tool_name = 'nexus_mission_set_status'),
  source                  TEXT NOT NULL CHECK (source IN ('http-mcp', 'pty-stream')),
  authority_sha256        TEXT NOT NULL CHECK (length(authority_sha256) = 64),
  payload_sha256          TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  final_output            TEXT NOT NULL CHECK (length(trim(final_output)) >= 40),
  final_output_sha256     TEXT NOT NULL CHECK (length(final_output_sha256) = 64),
  maestro_perspective     TEXT NOT NULL CHECK (length(trim(maestro_perspective)) >= 20),
  maestro_sha256          TEXT NOT NULL CHECK (length(maestro_sha256) = 64),
  issued_at               INTEGER NOT NULL CHECK (issued_at >= 0),
  created_at              INTEGER NOT NULL CHECK (created_at >= issued_at),
  PRIMARY KEY (mission_id, intent_version, orchestrator_session_id),
  CHECK (receipt_id = tool_call_id),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE INDEX idx_fanout_consolidation_session
  ON mission_fanout_consolidation_receipts(
    mission_id, orchestrator_session_id, created_at
  );

CREATE TRIGGER mission_fanout_consolidation_immutable
BEFORE UPDATE ON mission_fanout_consolidation_receipts
BEGIN
  SELECT RAISE(ABORT, 'mission fanout consolidation receipt is immutable');
END;
`;

/**
 * Durable within-roster provider reroute. When a sealed worker CLI exhausts
 * its physical spawn attempts, the coordinator may re-bind the dispatch to
 * another agent of the SAME sealed roster (same category). The directive is
 * the only authority the claim gate accepts for that substitution and it
 * carries the exhausted adapter set so the reroute chain is bounded.
 */
const TASK_PROVIDER_REROUTE_SCHEMA = `
ALTER TABLE task_dispatch_queue ADD COLUMN provider_reroute_json TEXT;
`;

/**
 * Diagnóstico durável de missão que não sela. Uma missão pode entregar 100% do
 * trabalho (tasks done, dispatches completed, worktrees integrated) e mesmo
 * assim ficar eterna em `running` porque o autopilot do PREVC se declara
 * not-ready e o driver decide `wait` — dezenas de vezes, a cada tick de 5s.
 * O motivo de ambos existia SÓ em memória: o gate de release morria por
 * timeout sem nome de causa, e o post-mortem no banco não tinha o que ler.
 *
 * Uma linha por missão, last-writer-wins de propósito: a 5s por tick um ledger
 * append-only cresceria sem limite e o valor diagnóstico está no motivo ATUAL,
 * não na repetição dele. Timestamps separados porque as duas camadas decidem
 * em ritmos diferentes.
 */
const MISSION_STALL_DIAGNOSTICS_SCHEMA = `
ALTER TABLE mission_drive_state ADD COLUMN last_wait_reason TEXT;
ALTER TABLE mission_drive_state ADD COLUMN last_wait_reason_at INTEGER
  CHECK (last_wait_reason_at IS NULL OR last_wait_reason_at >= 0);
ALTER TABLE mission_drive_state ADD COLUMN last_autopilot_reason TEXT;
ALTER TABLE mission_drive_state ADD COLUMN last_autopilot_reason_at INTEGER
  CHECK (last_autopilot_reason_at IS NULL OR last_autopilot_reason_at >= 0);
`;

/**
 * Hash chain over the physical handoff receipts of one mission (derived from
 * block/buzz crates/buzz-audit — see src/shared/receipt-chain.ts). Each new
 * receipt is inserted with its 1-based chain_seq, the chain_hash of the
 * previous receipt of the SAME mission (NULL for genesis, hashed as 32 zero
 * bytes) and its own chain_hash covering every receipt column plus that link.
 *
 * Columns are nullable only for migration compatibility: pre-029 rows are
 * immutable (UPDATE trigger) and cannot be safely backfilled, so legacy rows
 * stay outside the chain. The single writer (handoff-store.ts) computes the
 * link inside the same transaction that inserts the receipt; the partial
 * unique index makes a double-append of the same chain position impossible.
 */
const HANDOFF_RECEIPT_CHAIN_SCHEMA = `
ALTER TABLE handoff_mcp_receipts ADD COLUMN chain_seq INTEGER
  CHECK (chain_seq IS NULL OR chain_seq >= 1);
ALTER TABLE handoff_mcp_receipts ADD COLUMN prev_receipt_hash TEXT
  CHECK (
    (prev_receipt_hash IS NULL OR length(prev_receipt_hash) = 64)
    AND (prev_receipt_hash IS NULL OR chain_seq >= 2)
  );
ALTER TABLE handoff_mcp_receipts ADD COLUMN chain_hash TEXT
  CHECK (
    (chain_hash IS NULL OR length(chain_hash) = 64)
    AND ((chain_hash IS NULL) = (chain_seq IS NULL))
  );

CREATE UNIQUE INDEX idx_handoff_mcp_receipts_chain_seq
  ON handoff_mcp_receipts(mission_id, chain_seq)
  WHERE chain_seq IS NOT NULL;
`;

/**
 * Cryptographic agent identity (NIP-OA). Public keys + issued attestations +
 * revocation tombstones live in the project DB. Private keys NEVER land here
 * — they are stored only in the encrypted secrets vault
 * (`agentkey:v1:<mission>:<role>:<id>`).
 *
 * Attestation columns on handoff_mcp_receipts are nullable for migration
 * compatibility: legacy receipts stay outside the identity gate; new writes
 * under `agentAttestationGate=required` populate and verify them.
 */
const AGENT_IDENTITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS mission_agent_identity (
  mission_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'agent')),
  identity_id TEXT NOT NULL,
  public_key_hex TEXT NOT NULL CHECK (length(public_key_hex) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
  PRIMARY KEY (mission_id, role, identity_id)
);

CREATE TABLE IF NOT EXISTS mission_agent_attestations (
  mission_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  owner_pubkey TEXT NOT NULL CHECK (length(owner_pubkey) = 64),
  agent_pubkey TEXT NOT NULL CHECK (length(agent_pubkey) = 64),
  conditions TEXT NOT NULL,
  credential_json TEXT NOT NULL,
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  PRIMARY KEY (mission_id, owner_pubkey, credential_json)
);

CREATE INDEX IF NOT EXISTS idx_mission_agent_attestations_agent
  ON mission_agent_attestations(mission_id, agent_id);

CREATE TABLE IF NOT EXISTS mission_agent_revocations (
  mission_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_pubkey TEXT NOT NULL CHECK (length(owner_pubkey) = 64),
  revoked_at INTEGER NOT NULL CHECK (revoked_at >= 0),
  PRIMARY KEY (mission_id, owner_id)
);

ALTER TABLE handoff_mcp_receipts ADD COLUMN agent_pubkey TEXT
  CHECK (agent_pubkey IS NULL OR length(agent_pubkey) = 64);
ALTER TABLE handoff_mcp_receipts ADD COLUMN owner_pubkey TEXT
  CHECK (owner_pubkey IS NULL OR length(owner_pubkey) = 64);
ALTER TABLE handoff_mcp_receipts ADD COLUMN attestation_json TEXT;
`;

/**
 * ACP speaks MCP over a short-lived stdio bridge. The bridge still enters the
 * authenticated loopback boundary, but immutable receipts retain that
 * physical transport instead of collapsing it into ordinary HTTP MCP.
 * SQLite CHECK constraints require a table rebuild.
 */
const ACP_STDIO_PROVENANCE_SCHEMA = `
DROP TRIGGER IF EXISTS handoff_mcp_receipt_immutable;
DROP INDEX IF EXISTS idx_handoff_mcp_receipts_worker;
DROP INDEX IF EXISTS idx_handoff_mcp_receipts_logical_operation;
DROP INDEX IF EXISTS idx_handoff_mcp_receipts_chain_seq;
ALTER TABLE handoff_mcp_receipts RENAME TO handoff_mcp_receipts_v30;

CREATE TABLE handoff_mcp_receipts (
  receipt_id             TEXT PRIMARY KEY,
  handoff_id             TEXT NOT NULL UNIQUE,
  tool_call_id           TEXT NOT NULL UNIQUE,
  tool_name              TEXT NOT NULL CHECK (tool_name = 'nexus_handoff_submit'),
  source                 TEXT NOT NULL CHECK (
    source IN ('http-mcp', 'acp-stdio', 'pty-stream', 'omp-rpc-stdio')
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
  chain_seq              INTEGER CHECK (chain_seq IS NULL OR chain_seq >= 1),
  prev_receipt_hash      TEXT CHECK (
    (prev_receipt_hash IS NULL OR length(prev_receipt_hash) = 64)
    AND (prev_receipt_hash IS NULL OR chain_seq >= 2)
  ),
  chain_hash             TEXT CHECK (
    (chain_hash IS NULL OR length(chain_hash) = 64)
    AND ((chain_hash IS NULL) = (chain_seq IS NULL))
  ),
  agent_pubkey           TEXT CHECK (agent_pubkey IS NULL OR length(agent_pubkey) = 64),
  owner_pubkey           TEXT CHECK (owner_pubkey IS NULL OR length(owner_pubkey) = 64),
  attestation_json       TEXT,
  FOREIGN KEY (handoff_id) REFERENCES handoffs(id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

INSERT INTO handoff_mcp_receipts (
  receipt_id, handoff_id, tool_call_id, tool_name, source,
  mission_id, session_id, worker_incarnation_id, authority_sha256,
  worktree_head_sha, issued_at, raw_payload_sha256, logical_operation_key,
  chain_seq, prev_receipt_hash, chain_hash,
  agent_pubkey, owner_pubkey, attestation_json
)
SELECT
  receipt_id, handoff_id, tool_call_id, tool_name, source,
  mission_id, session_id, worker_incarnation_id, authority_sha256,
  worktree_head_sha, issued_at, raw_payload_sha256, logical_operation_key,
  chain_seq, prev_receipt_hash, chain_hash,
  agent_pubkey, owner_pubkey, attestation_json
FROM handoff_mcp_receipts_v30;

DROP TABLE handoff_mcp_receipts_v30;

CREATE INDEX idx_handoff_mcp_receipts_worker
  ON handoff_mcp_receipts(mission_id, session_id, worker_incarnation_id, issued_at);
CREATE UNIQUE INDEX idx_handoff_mcp_receipts_logical_operation
  ON handoff_mcp_receipts(logical_operation_key)
  WHERE logical_operation_key IS NOT NULL;
CREATE UNIQUE INDEX idx_handoff_mcp_receipts_chain_seq
  ON handoff_mcp_receipts(mission_id, chain_seq)
  WHERE chain_seq IS NOT NULL;
CREATE TRIGGER handoff_mcp_receipt_immutable
BEFORE UPDATE ON handoff_mcp_receipts
BEGIN
  SELECT RAISE(ABORT, 'handoff physical receipt is immutable');
END;

DROP TRIGGER IF EXISTS handoff_ack_receipts_immutable;
DROP INDEX IF EXISTS idx_handoff_ack_receipts_mission;
DROP INDEX IF EXISTS idx_handoff_ack_receipts_handoff;
ALTER TABLE handoff_ack_receipts RENAME TO handoff_ack_receipts_v26;
CREATE TABLE handoff_ack_receipts (
  receipt_id              TEXT PRIMARY KEY,
  handoff_id              TEXT NOT NULL,
  delivery_attempt_id     TEXT NOT NULL UNIQUE,
  tool_call_id            TEXT NOT NULL UNIQUE,
  tool_name               TEXT NOT NULL CHECK (tool_name = 'nexus_handoff_ack'),
  source                  TEXT NOT NULL CHECK (source IN ('http-mcp', 'acp-stdio', 'pty-stream')),
  mission_id              TEXT NOT NULL,
  orchestrator_session_id TEXT NOT NULL,
  authority_sha256        TEXT NOT NULL CHECK (length(authority_sha256) = 64),
  payload_sha256          TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  issued_at               INTEGER NOT NULL CHECK (issued_at >= 0),
  acknowledged_at         INTEGER NOT NULL CHECK (acknowledged_at >= issued_at),
  CHECK (receipt_id = tool_call_id),
  FOREIGN KEY (handoff_id) REFERENCES handoffs(id) ON DELETE CASCADE,
  FOREIGN KEY (delivery_attempt_id) REFERENCES handoff_delivery_attempts(id) ON DELETE CASCADE,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);
INSERT INTO handoff_ack_receipts SELECT * FROM handoff_ack_receipts_v26;
DROP TABLE handoff_ack_receipts_v26;
CREATE INDEX idx_handoff_ack_receipts_mission
  ON handoff_ack_receipts(mission_id, orchestrator_session_id, acknowledged_at);
CREATE INDEX idx_handoff_ack_receipts_handoff
  ON handoff_ack_receipts(handoff_id, orchestrator_session_id, acknowledged_at);
CREATE TRIGGER handoff_ack_receipts_immutable
BEFORE UPDATE ON handoff_ack_receipts
BEGIN
  SELECT RAISE(ABORT, 'handoff ACK receipt is immutable');
END;

DROP TRIGGER IF EXISTS mission_fanout_consolidation_immutable;
DROP INDEX IF EXISTS idx_fanout_consolidation_session;
ALTER TABLE mission_fanout_consolidation_receipts RENAME TO mission_fanout_consolidation_v26;
CREATE TABLE mission_fanout_consolidation_receipts (
  mission_id              TEXT NOT NULL,
  intent_version          INTEGER NOT NULL CHECK (intent_version >= 0),
  plan_hash               TEXT NOT NULL CHECK (length(plan_hash) = 64),
  topology                TEXT NOT NULL CHECK (topology = 'team-read-only-fanout'),
  orchestrator_session_id TEXT NOT NULL,
  receipt_id              TEXT NOT NULL UNIQUE,
  tool_call_id            TEXT NOT NULL UNIQUE,
  tool_name               TEXT NOT NULL CHECK (tool_name = 'nexus_mission_set_status'),
  source                  TEXT NOT NULL CHECK (source IN ('http-mcp', 'acp-stdio', 'pty-stream')),
  authority_sha256        TEXT NOT NULL CHECK (length(authority_sha256) = 64),
  payload_sha256          TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  final_output            TEXT NOT NULL CHECK (length(trim(final_output)) >= 40),
  final_output_sha256     TEXT NOT NULL CHECK (length(final_output_sha256) = 64),
  maestro_perspective     TEXT NOT NULL CHECK (length(trim(maestro_perspective)) >= 20),
  maestro_sha256          TEXT NOT NULL CHECK (length(maestro_sha256) = 64),
  issued_at               INTEGER NOT NULL CHECK (issued_at >= 0),
  created_at              INTEGER NOT NULL CHECK (created_at >= issued_at),
  PRIMARY KEY (mission_id, intent_version, orchestrator_session_id),
  CHECK (receipt_id = tool_call_id),
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);
INSERT INTO mission_fanout_consolidation_receipts SELECT * FROM mission_fanout_consolidation_v26;
DROP TABLE mission_fanout_consolidation_v26;
CREATE INDEX idx_fanout_consolidation_session
  ON mission_fanout_consolidation_receipts(mission_id, orchestrator_session_id, created_at);
CREATE TRIGGER mission_fanout_consolidation_immutable
BEFORE UPDATE ON mission_fanout_consolidation_receipts
BEGIN
  SELECT RAISE(ABORT, 'mission fanout consolidation receipt is immutable');
END;
`;

/**
 * Uma task dispensada por provider indisponível grava `status = 'done'` na
 * MESMA coluna de uma task entregue. O motivo existia só em
 * `task_dispatch_queue.integration_receipt_json`, então toda superfície que lê
 * `tasks` sem join (lista de tasks do renderer, registry de worktree,
 * leituras de status do workflow) mostrava trabalho que ninguém fez como
 * entregue — a origem da queixa de "critérios não seguidos".
 *
 * A marca vive aqui para ser legível SEM join, e é escrita exclusivamente pela
 * transação do waiver (`completeSealedAdvisoryProviderWaiver`), na mesma
 * instrução que move a task para `done`. NULL = a task não foi dispensada.
 *
 * Não há caminho de limpeza porque não há caminho de volta: a task dispensada
 * pertence a um plano selado (TaskStore.update recusa planned tasks) e todas
 * as transições de reabertura do dispatch exigem status running/failed/pending
 * — `done` nunca volta dentro da mesma intentVersion.
 */
const TASK_PROVIDER_WAIVER_VISIBILITY_SCHEMA = `
ALTER TABLE tasks ADD COLUMN provider_waiver_reason TEXT
  CHECK (
    provider_waiver_reason IS NULL
    OR (length(provider_waiver_reason) BETWEEN 1 AND 2000)
  );
`;

/**
 * A cadeia de receipts (029/031) declara a intenção "prev_receipt_hash só
 * existe em elos de posição >= 2" num CHECK — mas em SQLite um CHECK que
 * avalia NULL NÃO reprova a linha. Com `chain_seq` NULL a expressão
 * `chain_seq >= 2` vira NULL e a linha passa mesmo carregando um prev hash,
 * ou seja, exatamente o caso que o CHECK queria proibir.
 *
 * O reforço vem como trigger e não como CHECK endurecido de propósito: SQLite
 * não altera CHECK sem reconstruir a tabela, e reconstruir `handoff_mcp_receipts`
 * (copiando todos os receipts de todas as missões de todos os usuários) é um
 * risco desproporcional para fechar uma brecha de tampering. O trigger cobre o
 * único vetor restante — INSERT —, já que qualquer UPDATE na tabela é abortado
 * pelo trigger de imutabilidade.
 *
 * DELETE continua deliberadamente sem trigger: `handoff_mcp_receipts` tem
 * ON DELETE CASCADE de `handoffs` e de `missions`, e apagar uma missão é
 * operação suportada (MissionStore.remove/removeIfUnchanged). Um ABORT geral
 * em DELETE tornaria impossível remover qualquer missão com receipts, e SQLite
 * não permite distinguir a exclusão em cascata da direta dentro do trigger.
 * A cadeia é por missão: apagar a missão apaga a cadeia inteira, o que é
 * remoção legítima, não adulteração. Deleção NO MEIO da cadeia continua
 * detectável por `verifyChain` (a contiguidade de `chain_seq` quebra); só a
 * truncagem do rabo é silenciosa — e essa é a limitação assumida aqui.
 */
const HANDOFF_RECEIPT_CHAIN_LINK_GUARD_SCHEMA = `
CREATE TRIGGER handoff_mcp_receipt_chain_link_guard
BEFORE INSERT ON handoff_mcp_receipts
WHEN NEW.prev_receipt_hash IS NOT NULL AND NEW.chain_seq IS NULL
BEGIN
  SELECT RAISE(ABORT, 'handoff receipt chain link requires its chain_seq');
END;
`;

/**
 * Vincula cada reserva de rota ao squad selado da missão no instante da reserva.
 * Espelha a coluna de contrato de roster do plano guiado (mission_task_plans),
 * mas para o caminho AGÊNTICO (route→spawn), onde não existe plano selado: a
 * store carimba `missions.squad_id` na criação da reserva e o gate recusa
 * consumir uma reserva cujo squad não seja o squad ATUAL da missão. É o vínculo
 * durável que fecha "agêntico ignora squad salvo" — o roteador passa a VINCULAR
 * o squad selecionado, não apenas a sugerir a rota.
 *
 * Coluna nullable por compatibilidade de migração: reservas pré-034 e missões
 * sem squad ficam NULL; a leitura fail-open trata NULL == "sem squad", então
 * missões livres (sem squad selado) seguem roteando/spawnando como antes.
 */
const MISSION_ROUTE_RESERVATION_SQUAD_BINDING_SCHEMA = `
ALTER TABLE mission_route_reservations ADD COLUMN squad_id TEXT;
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
    {
      id: '026-fanout-physical-completion-proof',
      schemaVersion: 26,
      appVersion: '0.19.38',
      sql: FANOUT_PHYSICAL_COMPLETION_PROOF_SCHEMA,
    },
    {
      id: '027-task-provider-reroute',
      schemaVersion: 27,
      appVersion: '0.19.42',
      sql: TASK_PROVIDER_REROUTE_SCHEMA,
    },
    {
      id: '028-mission-stall-diagnostics',
      schemaVersion: 28,
      appVersion: '0.20.2',
      sql: MISSION_STALL_DIAGNOSTICS_SCHEMA,
    },
    {
      id: '029-handoff-receipt-chain',
      // CONGELADO. `appVersion` entra no checksum da migração E é comparado
      // linha a linha contra `__nexus_schema_migrations.app_version`
      // (validateAppliedHistory): corrigir este '0.20.4' para a release em que
      // a migração de fato saiu (0.21.0, já publicada com ela) derrubaria todo
      // banco existente em migration_history_invalid + checksum_mismatch, ou
      // seja, runtime em modo somente-leitura seguro para quem já migrou —
      // confirmado num banco local (app_version '0.20.4', applied_by '0.20.3').
      // O campo documenta a versão de autoria e é imutável depois do primeiro
      // usuário; migrações NOVAS devem nascer com a versão correta.
      schemaVersion: 29,
      appVersion: '0.20.4',
      sql: HANDOFF_RECEIPT_CHAIN_SCHEMA,
    },
    {
      id: '030-agent-identity',
      schemaVersion: 30,
      appVersion: '0.21.0',
      sql: AGENT_IDENTITY_SCHEMA,
    },
    {
      id: '031-acp-stdio-provenance',
      schemaVersion: 31,
      appVersion: '0.21.0',
      sql: ACP_STDIO_PROVENANCE_SCHEMA,
    },
    {
      id: '032-task-provider-waiver-visibility',
      schemaVersion: 32,
      appVersion: '0.21.0',
      sql: TASK_PROVIDER_WAIVER_VISIBILITY_SCHEMA,
    },
    {
      id: '033-handoff-receipt-chain-link-guard',
      schemaVersion: 33,
      appVersion: '0.21.0',
      sql: HANDOFF_RECEIPT_CHAIN_LINK_GUARD_SCHEMA,
    },
    {
      id: '034-mission-route-reservation-squad-binding',
      schemaVersion: 34,
      appVersion: '0.25.1',
      sql: MISSION_ROUTE_RESERVATION_SQUAD_BINDING_SCHEMA,
    },
  ];
