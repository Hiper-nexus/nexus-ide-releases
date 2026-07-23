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
  const marker = "[NEXUS_TASK_DISPATCH_BLOCKED]";
  const row = db
    .prepare(`SELECT description FROM missions WHERE id = ?`)
    .get(missionId) as { description: string } | undefined;
  if (!row)
    throw new Error(`missão não encontrada para bloqueio: ${missionId}`);
  const cta =
    `${marker}\n## Worker bloqueado\n${detail}\n` +
    "Clique em “Retomar missão” para revisar a tarefa e escolher a próxima ação.";
  const description = row.description.includes(marker)
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
