import {
  hasCurrentApprovedDispatchContract,
  missionIntentContractSchema,
} from "../../shared/mission-intent";
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
} from "./scoped-store";
import {
  taskDispatchIdSchema,
  type TaskDispatchRecord,
} from "./task-dispatch-codec";
import {
  blockTaskDispatchMission,
  getTaskDispatchFromDatabase,
  type TaskDispatchDatabase,
} from "./task-dispatch-persistence";

const EFFECT_AUTHORITY_INTENT_STATES = new Set([
  "dispatched",
  "executing",
  "validating",
]);

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
  if (
    mission.status !== "running" ||
    !EFFECT_AUTHORITY_INTENT_STATES.has(mission.intent_state)
  ) {
    throw new Error(
      `autoridade lifecycle revogada: missão=${mission.status}, intent=${mission.intent_state}`,
    );
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
}

export interface AcceptTaskDispatchHandoffInput {
  readonly sessionId: string;
  readonly workerIncarnationId: string;
  readonly handoffId: string;
}

export function acceptTaskDispatchHandoff(
  binding: ScopedStoreBinding,
  input: AcceptTaskDispatchHandoffInput,
): TaskDispatchRecord {
  const sessionId = taskDispatchIdSchema.parse(input.sessionId);
  const workerIncarnationId = taskDispatchIdSchema.parse(
    input.workerIncarnationId,
  );
  const handoffId = taskDispatchIdSchema.parse(input.handoffId);
  const db = binding.writeDatabase();
  const now = binding.now();
  const record = db
    .transaction(() => {
      const row = db
        .prepare(
          `SELECT dispatch.task_id, dispatch.mission_id,
                  dispatch.intent_version, dispatch.revision
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
      const handoff = db
        .prepare(
          `SELECT mission_id, session_id, worker_incarnation_id, status
         FROM handoffs WHERE id = ?`,
        )
        .get(handoffId) as
        | {
            mission_id: string | null;
            session_id: string | null;
            worker_incarnation_id: string | null;
            status: string;
          }
        | undefined;
      if (
        !handoff ||
        handoff.mission_id !== row.mission_id ||
        handoff.session_id !== sessionId ||
        handoff.worker_incarnation_id !== workerIncarnationId ||
        handoff.status !== "success"
      ) {
        throw new Error(
          "handoff não pertence ao dispatch/sessão ou não é success",
        );
      }
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
      return getTaskDispatchFromDatabase(db, row.task_id, binding.coordinates);
    })
    .immediate();
  if (!record) throw new Error("dispatch desapareceu após handoff");
  binding.emitChange();
  return record;
}

export interface BlockTaskDispatchFromHandoffInput {
  readonly sessionId: string;
  readonly workerIncarnationId: string;
  readonly handoffId: string;
  readonly detail: string;
}

export function blockTaskDispatchFromHandoff(
  binding: ScopedStoreBinding,
  input: BlockTaskDispatchFromHandoffInput,
): TaskDispatchRecord {
  const sessionId = taskDispatchIdSchema.parse(input.sessionId);
  const workerIncarnationId = taskDispatchIdSchema.parse(
    input.workerIncarnationId,
  );
  const handoffId = taskDispatchIdSchema.parse(input.handoffId);
  const detail = input.detail.slice(0, 65_536);
  const now = binding.now();
  const db = binding.writeDatabase();
  const record = db
    .transaction(() => {
      const row = db
        .prepare(
          `SELECT dispatch.task_id, dispatch.mission_id,
                  dispatch.intent_version, dispatch.revision
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
          }
        | undefined;
      if (!row)
        throw new Error(`nenhum dispatch ativo para a sessão ${sessionId}`);
      assertTaskDispatchMissionLifecycleAuthority(
        db,
        row.mission_id,
        row.intent_version,
      );
      const handoff = db
        .prepare(
          `SELECT mission_id, session_id, worker_incarnation_id
         FROM handoffs WHERE id = ?`,
        )
        .get(handoffId) as
        | {
            mission_id: string | null;
            session_id: string | null;
            worker_incarnation_id: string | null;
          }
        | undefined;
      if (
        !handoff ||
        handoff.mission_id !== row.mission_id ||
        handoff.session_id !== sessionId ||
        handoff.worker_incarnation_id !== workerIncarnationId
      ) {
        throw new Error("handoff não pertence à encarnação ativa do worker");
      }
      const updated = db
        .prepare(
          `UPDATE task_dispatch_queue
         SET state = 'blocked', handoff_id = ?, last_error = ?,
             revision = revision + 1, updated_at = ?
         WHERE task_id = ? AND revision = ? AND worker_incarnation_id = ?
           AND state = 'running'`,
        )
        .run(
          handoffId,
          detail,
          now,
          row.task_id,
          row.revision,
          workerIncarnationId,
        );
      if (updated.changes !== 1)
        throw new Error("block perdeu CAS do dispatch");
      db.prepare(
        `UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?`,
      ).run(now, row.task_id);
      blockTaskDispatchMission(db, row.mission_id, detail, now);
      return getTaskDispatchFromDatabase(db, row.task_id, binding.coordinates);
    })
    .immediate();
  if (!record) throw new Error("dispatch desapareceu após block");
  binding.emitChange();
  return record;
}
