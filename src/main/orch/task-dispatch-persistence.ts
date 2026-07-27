import type { ScopedStoreBinding } from "./scoped-store";
import type { ScopeCoordinates } from "./scoped-store";
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
export const TASK_DISPATCH_SESSION_EXIT_REASON =
  "O worker encerrou sem entregar um handoff confiável.";
const TASK_DISPATCH_RESUME_CTA =
  "Clique em “Retomar missão” para revisar a tarefa e escolher a próxima ação.";

function taskDispatchMissionBlock(detail: string): string {
  return (
    `${TASK_DISPATCH_BLOCK_MARKER}\n## Worker bloqueado\n${detail}\n` +
    TASK_DISPATCH_RESUME_CTA
  );
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
): void {
  const row = db
    .prepare(`SELECT status, description FROM missions WHERE id = ?`)
    .get(missionId) as
    | { status: string; description: string }
    | undefined;
  if (!row)
    throw new Error(`missão não encontrada para bloqueio: ${missionId}`);
  const cta = taskDispatchMissionBlock(detail);
  // Mission descriptions contain operator-authored text. Never treat a marker
  // merely present in that text as durable state: on the running→blocked
  // transition we must append our own complete suffix. Idempotency is allowed
  // only after the mission is already blocked by the exact same canonical
  // suffix.
  const alreadyBlockedByThisReason =
    row.status === "blocked" && row.description.endsWith(cta);
  const description = alreadyBlockedByThisReason
    ? row.description
    : (row.description.trim() ? `${row.description}\n\n${cta}` : cta).slice(
        0,
        65_536,
      );
  db.prepare(
    `UPDATE missions SET status = 'blocked', description = ?, updated_at = ?
     WHERE id = ?`,
  ).run(description, now, missionId);
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
