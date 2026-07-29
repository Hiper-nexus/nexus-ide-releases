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

/**
 * Removes only the exact technical block appended for this dispatch attempt.
 * A different block, an operator block, or lifecycle drift remains terminal:
 * callers may never reopen a mission merely because a provider retry is due.
 */
export function resumeTaskDispatchMissionAfterTechnicalFailure(
  db: TaskDispatchDatabase,
  missionId: string,
  detail: string | null,
  now: number,
): void {
  const row = db
    .prepare(
      `SELECT status, intent_state, description FROM missions WHERE id = ?`,
    )
    .get(missionId) as
    | { status: string; intent_state: string | null; description: string }
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
  const suffix = taskDispatchMissionBlock(detail);
  if (!row.description.endsWith(suffix)) {
    throw new Error(
      "retry técnico não corresponde ao bloco canônico atual da missão",
    );
  }
  const prefix = row.description.slice(0, -suffix.length);
  const description = prefix.endsWith("\n\n")
    ? prefix.slice(0, -2)
    : prefix;
  const updated = db
    .prepare(
      `UPDATE missions
          SET status = 'running', intent_state = 'executing',
              description = ?, updated_at = ?
        WHERE id = ? AND status = 'blocked'
          AND intent_state = 'blocked_technical' AND description = ?`,
    )
    .run(description, now, missionId, row.description);
  if (updated.changes !== 1) {
    throw new Error("retry técnico perdeu CAS ao reabrir a missão");
  }
}

/**
 * Extract the last durable worker-block detail from a mission description.
 * Used by the release-gate evidence so FAIL reports the exact fence, not null.
 */
export function taskDispatchBlockDetailFromDescription(
  description: string,
): string | null {
  const marker = TASK_DISPATCH_BLOCK_MARKER;
  const start = description.lastIndexOf(marker);
  if (start < 0) return null;
  const after = description.slice(start + marker.length);
  const heading = "## Worker bloqueado\n";
  const headAt = after.indexOf(heading);
  if (headAt < 0) return null;
  let body = after.slice(headAt + heading.length);
  const ctaAt = body.indexOf(TASK_DISPATCH_RESUME_CTA);
  if (ctaAt >= 0) body = body.slice(0, ctaAt);
  const detail = body.trim();
  return detail.length > 0 ? detail.slice(0, 4_000) : null;
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
    .prepare(
      `SELECT status, intent_state, description FROM missions WHERE id = ?`,
    )
    .get(missionId) as
    | { status: string; intent_state: string | null; description: string }
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
  // Field trap (28/07): this raw UPDATE set status='blocked' and left
  // intent_state untouched, so every dispatch block produced the inconsistent
  // pair `blocked` + `dispatched|executing|validating`. MissionStore.update()
  // normalizes that pair, but this SQL bypasses it, and #fromRow returns the
  // raw column — so guards reading `mission.intentState` saw `dispatched`
  // while `resolveEffectiveIntentState` projected `blocked_user`. That split
  // between projection and column is what wedged missions with no exit.
  //
  // These are dispatch failures — worktree, merge, expired lease, session exit.
  // `blocked_technical` is what every other mission blocker writes here
  // (missionBlockPatch('technical')). It also matters for recovery: the
  // projection default for a dirty pair is `blocked_user`, which makes
  // `isRecoveryEligibleIntentState` false and silently drops the mission from
  // the Mission Driver scan and the delegation supervisor — automatic recovery
  // switched off with nothing saying so. Nothing auto-resumes
  // `blocked_technical` (driver, scheduler and bootstrap all require running),
  // so this restores the truth without widening any authority.
  db.prepare(
    `UPDATE missions
        SET status = 'blocked', intent_state = ?, description = ?, updated_at = ?
      WHERE id = ?`,
  ).run('blocked_technical', description, now, missionId);
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
