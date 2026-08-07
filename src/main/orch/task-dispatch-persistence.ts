import {
  missionIntentStateSchema,
} from "../../shared/mission-intent";
import { missionStatusSchema } from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import type { MissionEngine } from "./mission-engine";
import type { ScopedStoreBinding } from "./scoped-store";
import type { ScopeCoordinates } from "./scoped-store";
import { inferWorkerDecisionGuidance } from "../../shared/worker-decision-guidance";
import {
  parseTaskDispatchDatabaseRow,
  taskDispatchRecordFromParsedRow,
  type TaskDispatchRecord,
  type TaskDispatchRow,
} from "./task-dispatch-codec";

export type TaskDispatchDatabase = ReturnType<
  ScopedStoreBinding["readDatabase"]
>;

export const TASK_DISPATCH_BLOCK_MARKER = "[NEXUS_TASK_DISPATCH_BLOCKED]";
/** Worker-authored block (governance, product decision) — needs the operator. */
export const TASK_DISPATCH_WORKER_DECISION_MARKER =
  "[NEXUS_WORKER_DECISION_BLOCKED]";
export const TASK_DISPATCH_SESSION_EXIT_REASON =
  "O worker encerrou sem entregar um handoff confiável.";
const TASK_DISPATCH_RESUME_CTA =
  "Clique em “Retomar missão” para revisar a tarefa e escolher a próxima ação.";
const TASK_DISPATCH_WORKER_DECISION_CTA =
  "A missão ficou parada na pane — diga o que fazer: mudar o objetivo, autorizar o caminho, ou encerrar de propósito.";

function taskDispatchMissionBlock(
  detail: string,
  kind: "technical" | "user" = "technical",
): string {
  if (kind === "user") {
    const guidance = inferWorkerDecisionGuidance(detail);
    const optionLines = guidance.options
      .map((option, index) => `${index + 1}. ${option}`)
      .join("\n");
    return (
      `${TASK_DISPATCH_WORKER_DECISION_MARKER}\n## Worker pediu decisão\n` +
      `${guidance.summary}\n\n` +
      `Pergunta: ${guidance.question}\n` +
      `${optionLines}\n` +
      `Motivo do worker: ${detail.trim().slice(0, 3_000)}\n` +
      TASK_DISPATCH_WORKER_DECISION_CTA
    );
  }
  return (
    `${TASK_DISPATCH_BLOCK_MARKER}\n## Worker bloqueado\n${detail}\n` +
    TASK_DISPATCH_RESUME_CTA
  );
}
export function taskDispatchTechnicalResumeDescription(
  description: string,
  detail: string,
): string {
  const suffix = taskDispatchMissionBlock(detail);
  if (!description.endsWith(suffix)) {
    throw new Error(
      "retry técnico não corresponde ao bloco canônico atual da missão",
    );
  }
  let resumedDescription = description;
  do {
    const prefix = resumedDescription.slice(0, -suffix.length);
    resumedDescription = prefix.endsWith("\n\n")
      ? prefix.slice(0, -2)
      : prefix;
  } while (resumedDescription.endsWith(suffix));
  return resumedDescription;
}


/**
 * Removes the exact technical block appended for this dispatch attempt,
 * including identical trailing copies left by legacy resume loops. A different
 * block, an operator block, or lifecycle drift remains terminal: callers may
 * never reopen a mission merely because a provider retry is due.
 */
export function resumeTaskDispatchMissionAfterTechnicalFailure(
  db: TaskDispatchDatabase,
  missionId: string,
  detail: string | null,
  _now: number,
  engine: Pick<MissionEngine, "resumeTechnical">,
  scope: ProjectExecutionScope,
): void {
  const row = db
    .prepare(
      `SELECT status, intent_state, description, updated_at, intent_version
       FROM missions WHERE id = ?`,
    )
    .get(missionId) as
    | {
        status: string;
        intent_state: string | null;
        description: string;
        updated_at: number;
        intent_version: number;
      }
    | undefined;
  if (!row) {
    throw new Error(`missão não encontrada para retry técnico: ${missionId}`);
  }
  if (row.status === "running") return;
  if (
    row.status !== "blocked" ||
    row.intent_state !== "blocked_technical" ||
    !detail
  ) {
    throw new Error(
      "retry técnico não possui autoridade para reabrir esta missão",
    );
  }
  const description = taskDispatchTechnicalResumeDescription(
    row.description,
    detail,
  );
  engine.resumeTechnical(scope, {
    missionId,
    expectedStatus: "blocked",
    expectedIntentState: "blocked_technical",
    expectedUpdatedAt: row.updated_at,
    expectedIntentVersion: row.intent_version,
    description,
  });
}

/**
 * Extract the last durable worker-block detail from a mission description.
 * Used by the release-gate evidence so FAIL reports the exact fence, not null.
 */
export function taskDispatchBlockDetailFromDescription(
  description: string,
): string | null {
  const markers = [
    {
      marker: TASK_DISPATCH_WORKER_DECISION_MARKER,
      heading: "## Worker pediu decisão\n",
      cta: TASK_DISPATCH_WORKER_DECISION_CTA,
    },
    {
      marker: TASK_DISPATCH_BLOCK_MARKER,
      heading: "## Worker bloqueado\n",
      cta: TASK_DISPATCH_RESUME_CTA,
    },
  ] as const;
  for (const entry of markers) {
    const start = description.lastIndexOf(entry.marker);
    if (start < 0) continue;
    const after = description.slice(start + entry.marker.length);
    const headAt = after.indexOf(entry.heading);
    if (headAt < 0) continue;
    let body = after.slice(headAt + entry.heading.length);
    const ctaAt = body.indexOf(entry.cta);
    if (ctaAt >= 0) body = body.slice(0, ctaAt);
    const detail = body.trim();
    if (detail.length > 0) return detail.slice(0, 4_000);
  }
  return null;
}

export function getTaskDispatchRow(
  db: TaskDispatchDatabase,
  taskId: string,
): TaskDispatchRow | null {
  const raw = db
    .prepare(`SELECT * FROM task_dispatch_queue WHERE task_id = ?`)
    .get(taskId);
  return raw === undefined ? null : parseTaskDispatchDatabaseRow(raw);
}

export function getTaskDispatchFromDatabase(
  db: TaskDispatchDatabase,
  taskId: string,
  coordinates: ScopeCoordinates,
): TaskDispatchRecord | null {
  const row = getTaskDispatchRow(db, taskId);
  return row ? taskDispatchRecordFromParsedRow(row, coordinates) : null;
}

export function blockTaskDispatchMission(
  db: TaskDispatchDatabase,
  missionId: string,
  detail: string,
  now: number,
  kind: "user",
  engine: Pick<MissionEngine, "blockUser">,
  scope: ProjectExecutionScope,
): void;
export function blockTaskDispatchMission(
  db: TaskDispatchDatabase,
  missionId: string,
  detail: string,
  now: number,
  kind: "technical",
  engine: Pick<MissionEngine, "blockTechnical">,
  scope: ProjectExecutionScope,
): void;
export function blockTaskDispatchMission(
  db: TaskDispatchDatabase,
  missionId: string,
  detail: string,
  _now: number,
  /**
   * `technical` = spawn/lease/runtime fence (auto-recovery eligible path).
   * `user` = worker chose status=blocked (governance, product fork) — stay on
   * the pane, ask the operator, never paint as technical failure.
   */
  kind: "technical" | "user",
  engine:
    | Pick<MissionEngine, "blockUser">
    | Pick<MissionEngine, "blockTechnical">,
  scope: ProjectExecutionScope,
): void {
  const row = db
    .prepare(
      `SELECT status, intent_state, description, updated_at, intent_version
       FROM missions WHERE id = ?`,
    )
    .get(missionId) as
    | {
        status: string;
        intent_state: string | null;
        description: string;
        updated_at: number;
        intent_version: number;
      }
    | undefined;
  if (!row) {
    throw new Error(`missão não encontrada para bloqueio: ${missionId}`);
  }
  const cta = taskDispatchMissionBlock(detail, kind);
  if (row.status === "blocked" && row.description.endsWith(cta)) return;
  const description = (
    row.description.trim() ? `${row.description}\n\n${cta}` : cta
  ).slice(0, 65_536);
  const input = {
    missionId,
    expectedStatus: missionStatusSchema.parse(row.status),
    expectedIntentState: missionIntentStateSchema.parse(
      row.intent_state ?? "legacy",
    ),
    expectedUpdatedAt: row.updated_at,
    expectedIntentVersion: row.intent_version,
    description,
  };
  if (kind === "user") {
    if (!("blockUser" in engine)) {
      throw new TypeError("user block requires MissionEngine.blockUser");
    }
    engine.blockUser(scope, input);
  } else {
    if (!("blockTechnical" in engine)) {
      throw new TypeError(
        "technical block requires MissionEngine.blockTechnical",
      );
    }
    engine.blockTechnical(scope, input);
  }
}

/**
 * Refine the operator-facing block that was already committed by the exact
 * physical session-exit fence. The caller must prove the dispatch identity and
 * lease in the same transaction; this helper only replaces that one bounded
 * CTA and never changes mission lifecycle or receipt state.
 */
export function refineTaskDispatchMissionBlock(
  db: TaskDispatchDatabase,
  missionId: string,
  detail: string,
  now: number,
): void {
  const row = db
    .prepare(`SELECT status, description FROM missions WHERE id = ?`)
    .get(missionId) as
    | { status: string; description: string }
    | undefined;
  if (!row || row.status !== "blocked") {
    throw new Error(
      `missão não está bloqueada para refinar a causa: ${missionId}`,
    );
  }

  const genericBlock = taskDispatchMissionBlock(
    TASK_DISPATCH_SESSION_EXIT_REASON,
  );
  // The exact generic block is appended by blockTaskDispatchMission after the
  // running→blocked transition. Use the final complete occurrence so an
  // operator-authored marker (or even a copied CTA) can never become the
  // refinement target.
  const start = row.description.lastIndexOf(genericBlock);
  if (start < 0) {
    throw new Error(
      "missão bloqueada não contém o motivo genérico canônico do exit",
    );
  }
  const replacement = taskDispatchMissionBlock(detail);
  const description = (
    row.description.slice(0, start) +
    replacement +
    row.description.slice(start + genericBlock.length)
  ).slice(0, 65_536);
  const updated = db
    .prepare(
      `UPDATE missions SET description = ?, updated_at = ?
       WHERE id = ? AND status = 'blocked' AND description = ?`,
    )
    .run(description, now, missionId, row.description);
  if (updated.changes !== 1) {
    throw new Error("refinamento da causa da missão perdeu CAS");
  }
}
