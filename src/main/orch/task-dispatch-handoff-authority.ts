import {
  hasCurrentApprovedDispatchContract,
  missionIntentContractSchema,
} from "../../shared/mission-intent";
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopeCoordinates,
} from "./scoped-store";
import {
  taskDispatchIdSchema,
  type TaskDispatchRecord,
} from "./task-dispatch-codec";
import { emitWorkerDecisionClarify } from "./worker-decision-clarify";
import {
  blockTaskDispatchMission,
  getTaskDispatchFromDatabase,
  type TaskDispatchDatabase,
} from "./task-dispatch-persistence";
import {
  assertPhysicalTaskHandoffAuthority,
  type PhysicalTaskHandoffAuthority,
} from "./task-dispatch-physical-handoff-authority";

const EFFECT_AUTHORITY_INTENT_STATES = new Set([
  "dispatched",
  "executing",
  "validating",
]);
const SUCCESS_HANDOFF_REPLAY_STATES = new Set([
  "handoff_ready",
  "merging",
  "completed",
]);

function readTaskDispatchMissionAuthority(
  db: TaskDispatchDatabase,
  missionId: string,
  expectedIntentVersion: number,
): {
  readonly status: string;
  readonly intentState: string;
} {
  const mission = db
    .prepare(
      `SELECT status, intent_state, intent_version, intent_contract_json
       FROM missions WHERE id = ?`,
    )
    .get(missionId) as
    | {
        status: string;
        intent_state: string;
        intent_version: number;
        intent_contract_json: string | null;
      }
    | undefined;
  if (!mission) {
    throw new Error(`autoridade lifecycle ausente: missão ${missionId}`);
  }
  if (mission.intent_version !== expectedIntentVersion) {
    throw new Error(
      `intentVersion obsoleta: missão=${mission.intent_version}, dispatch=${expectedIntentVersion}`,
    );
  }
  if (!mission.intent_contract_json) {
    throw new Error("autoridade lifecycle exige contrato aprovado atual");
  }
  let contract;
  try {
    contract = missionIntentContractSchema.parse(
      JSON.parse(mission.intent_contract_json),
    );
  } catch (error) {
    throw new ScopedStoreCorruptionError(
      "task dispatch mission intent contract",
      { cause: error },
    );
  }
  if (
    !hasCurrentApprovedDispatchContract({
      intentContract: contract,
      intentVersion: mission.intent_version,
    })
  ) {
    throw new Error("autoridade lifecycle exige contrato aprovado atual");
  }
  return {
    status: mission.status,
    intentState: mission.intent_state,
  };
}

/**
 * One exact approved intent revision is the durable authority for dispatcher
 * effects. Call this inside the same SQLite transaction that mutates a
 * dispatch row or persists a receipt.
 */
export function assertTaskDispatchMissionLifecycleAuthority(
  db: TaskDispatchDatabase,
  missionId: string,
  expectedIntentVersion: number,
): void {
  const mission = readTaskDispatchMissionAuthority(
    db,
    missionId,
    expectedIntentVersion,
  );
  if (
    mission.status !== "running" ||
    !EFFECT_AUTHORITY_INTENT_STATES.has(mission.intentState)
  ) {
    throw new Error(
      `autoridade lifecycle revogada: missão=${mission.status}, intent=${mission.intentState}`,
    );
  }
}

export interface AcceptTaskDispatchHandoffInput {
  readonly sessionId: string;
  readonly workerIncarnationId: string;
  readonly handoffId: string;
}

interface CommitTaskDispatchHandoffInput {
  readonly sessionId: string;
  readonly workerIncarnationId: string;
  readonly handoffId: string;
  readonly outcome: "accept" | "block";
  readonly detail?: string;
}

export interface ResolveCommittedTaskDispatchHandoffReplayInput {
  readonly sessionId: string;
  readonly workerIncarnationId: string;
  readonly expectedStatus: "success" | "non-success";
}

export interface CommittedTaskDispatchHandoffReplay {
  readonly taskDispatch: TaskDispatchRecord;
  readonly physicalAuthority: PhysicalTaskHandoffAuthority;
}

/**
 * Recognize only a handoff already committed by this exact physical worker.
 *
 * `null` means the dispatch is still running and the caller may insert the
 * first handoff in the same transaction. Every other pre-existing state is
 * either one exact idempotent replay or a fail-closed conflict.
 */
export function resolveCommittedTaskDispatchHandoffReplayInTransaction(
  db: TaskDispatchDatabase,
  coordinates: ScopeCoordinates,
  input: ResolveCommittedTaskDispatchHandoffReplayInput,
  now: number,
): CommittedTaskDispatchHandoffReplay | null {
  const sessionId = taskDispatchIdSchema.parse(input.sessionId);
  const workerIncarnationId = taskDispatchIdSchema.parse(
    input.workerIncarnationId,
  );
  const rows = db
    .prepare(
      `SELECT task_id, mission_id, intent_version, worker_id, state, handoff_id
       FROM task_dispatch_queue
       WHERE session_id = ? AND worker_incarnation_id = ?`,
    )
    .all(sessionId, workerIncarnationId) as Array<{
    readonly task_id: string;
    readonly mission_id: string;
    readonly intent_version: number;
    readonly worker_id: string;
    readonly state: string;
    readonly handoff_id: string | null;
  }>;
  if (rows.length !== 1) {
    if (rows.length === 0) {
      throw new Error(`nenhum dispatch vinculado à sessão ${sessionId}`);
    }
    throw new ScopedStoreCorruptionError(
      "task dispatch physical session identity",
    );
  }
  const row = rows[0]!;
  if (row.state === "running") {
    if (row.handoff_id !== null) {
      throw new ScopedStoreCorruptionError(
        "running task dispatch with a committed handoff",
      );
    }
    return null;
  }
  if (!row.handoff_id) {
    throw new Error(
      "handoff replay recusado: dispatch não possui handoff físico vinculado",
    );
  }

  const expectedState =
    input.expectedStatus === "success"
      ? SUCCESS_HANDOFF_REPLAY_STATES.has(row.state)
      : row.state === "blocked";
  if (!expectedState) {
    throw new Error(
      `handoff replay recusado: estado ${row.state} diverge do resultado esperado`,
    );
  }
  const mission = readTaskDispatchMissionAuthority(
    db,
    row.mission_id,
    row.intent_version,
  );
  const missionStateMatches =
    input.expectedStatus === "success"
      ? mission.status === "running" || mission.status === "done"
      : mission.status === "blocked";
  if (!missionStateMatches) {
    throw new Error(
      `handoff replay recusado: missão ${mission.status} diverge do resultado esperado`,
    );
  }

  const physicalAuthority = assertPhysicalTaskHandoffAuthority(
    db,
    coordinates,
    {
      missionId: row.mission_id,
      handoffId: row.handoff_id,
      sessionId,
      workerIncarnationId,
      workerId: row.worker_id,
      noLaterThan: now,
      requireCorrelatedAuditIntent: true,
      expectedStatus: input.expectedStatus,
    },
  );
  const taskDispatch = getTaskDispatchFromDatabase(
    db,
    row.task_id,
    coordinates,
  );
  if (!taskDispatch) {
    throw new Error("dispatch desapareceu durante replay do handoff");
  }
  return { taskDispatch, physicalAuthority };
}

/**
 * Canonical SQLite port for binding a physical handoff to its dispatch.
 *
 * The caller may already own a wider transaction (the physical handoff
 * insert) or may wrap this function in one. Receipt, correlated audit intent,
 * dispatch CAS and terminal task/mission effects are therefore always proved
 * and committed as one SQLite unit.
 */
export function commitTaskDispatchHandoffInTransaction(
  db: TaskDispatchDatabase,
  coordinates: ScopeCoordinates,
  input: CommitTaskDispatchHandoffInput,
  now: number,
): TaskDispatchRecord {
  const sessionId = taskDispatchIdSchema.parse(input.sessionId);
  const workerIncarnationId = taskDispatchIdSchema.parse(
    input.workerIncarnationId,
  );
  const handoffId = taskDispatchIdSchema.parse(input.handoffId);
  const row = db
    .prepare(
      `SELECT dispatch.task_id, dispatch.mission_id,
                  dispatch.intent_version, dispatch.revision,
                  dispatch.worker_id
         FROM task_dispatch_queue AS dispatch
         WHERE dispatch.session_id = ?
           AND dispatch.worker_incarnation_id = ?
           AND dispatch.state = 'running'`,
    )
    .get(sessionId, workerIncarnationId) as
    | {
        task_id: string;
        mission_id: string;
        intent_version: number;
        revision: number;
        worker_id: string;
      }
    | undefined;
  if (!row) {
    throw new Error(`nenhum dispatch ativo para a sessão ${sessionId}`);
  }
  assertTaskDispatchMissionLifecycleAuthority(
    db,
    row.mission_id,
    row.intent_version,
  );
  assertPhysicalTaskHandoffAuthority(db, coordinates, {
    missionId: row.mission_id,
    handoffId,
    sessionId,
    workerIncarnationId,
    workerId: row.worker_id,
    noLaterThan: now,
    requireCorrelatedAuditIntent: true,
    expectedStatus: input.outcome === "accept" ? "success" : "non-success",
  });

  if (input.outcome === "accept") {
    const result = db
      .prepare(
        `UPDATE task_dispatch_queue
         SET state = 'handoff_ready', handoff_id = ?, revision = revision + 1,
             handoff_accepted_at = ?, updated_at = ?
         WHERE task_id = ? AND revision = ? AND session_id = ?
           AND worker_incarnation_id = ? AND state = 'running'`,
      )
      .run(
        handoffId,
        now,
        now,
        row.task_id,
        row.revision,
        sessionId,
        workerIncarnationId,
      );
    if (result.changes !== 1)
      throw new Error("handoff perdeu CAS do dispatch ativo");
  } else {
    if (typeof input.detail !== "string") {
      throw new Error("block from handoff exige detalhe terminal");
    }
    const detail = input.detail.slice(0, 65_536);
    if (!detail.trim()) {
      throw new Error("block from handoff exige detalhe terminal");
    }
    const updated = db
      .prepare(
        `UPDATE task_dispatch_queue
         SET state = 'blocked', handoff_id = ?, last_error = ?,
             revision = revision + 1, updated_at = ?
         WHERE task_id = ? AND revision = ? AND session_id = ?
           AND worker_incarnation_id = ? AND state = 'running'`,
      )
      .run(
        handoffId,
        detail,
        now,
        row.task_id,
        row.revision,
        sessionId,
        workerIncarnationId,
      );
    if (updated.changes !== 1) throw new Error("block perdeu CAS do dispatch");
    db.prepare(
      `UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?`,
    ).run(now, row.task_id);
    // Mission stays running here on purpose: clarify chips are written after
    // this transaction while status is still running (handoff submit refuses
    // blocked missions). blockTaskDispatchFromHandoff then flips to blocked_user.
  }

  const record = getTaskDispatchFromDatabase(db, row.task_id, coordinates);
  if (!record) {
    throw new Error(
      input.outcome === "accept"
        ? "dispatch desapareceu após handoff"
        : "dispatch desapareceu após block",
    );
  }
  return record;
}

export function acceptTaskDispatchHandoff(
  binding: ScopedStoreBinding,
  input: AcceptTaskDispatchHandoffInput,
): TaskDispatchRecord {
  const db = binding.writeDatabase();
  const now = binding.now();
  const record = db
    .transaction(() =>
      commitTaskDispatchHandoffInTransaction(
        db,
        binding.coordinates,
        {
          ...input,
          outcome: "accept",
        },
        now,
      ),
    )
    .immediate();
  binding.emitChange();
  return record;
}

export interface BlockTaskDispatchFromHandoffInput {
  readonly sessionId: string;
  readonly workerIncarnationId: string;
  readonly handoffId: string;
  readonly detail: string;
}

export function completeBlockedTaskDispatchHandoffPostCommit(
  binding: ScopedStoreBinding,
  record: TaskDispatchRecord,
  detail: string,
): void {
  const boundedDetail = detail.slice(0, 65_536);
  // Mission is still running: open chips first, then mark blocked_user.
  try {
    emitWorkerDecisionClarify(binding, record.missionId, boundedDetail);
  } catch (error) {
    console.warn(
      "[task-dispatch] worker-decision clarify skipped:",
      error instanceof Error ? error.message : error,
    );
  }
  // Worker chose status=blocked (governance / product fork) → human decision.
  blockTaskDispatchMission(
    binding.writeDatabase(),
    record.missionId,
    boundedDetail,
    binding.now(),
    "user",
  );
  binding.emitChange();
}

export function blockTaskDispatchFromHandoff(
  binding: ScopedStoreBinding,
  input: BlockTaskDispatchFromHandoffInput,
): TaskDispatchRecord {
  const now = binding.now();
  const db = binding.writeDatabase();
  const detail = input.detail.slice(0, 65_536);
  const record = db
    .transaction(() =>
      commitTaskDispatchHandoffInTransaction(
        db,
        binding.coordinates,
        {
          ...input,
          outcome: "block",
        },
        now,
      ),
    )
    .immediate();
  completeBlockedTaskDispatchHandoffPostCommit(binding, record, detail);
  return record;
}
