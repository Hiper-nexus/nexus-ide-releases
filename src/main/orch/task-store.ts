import type { Db } from '../persistence/db';
import type { TaskRecord, TaskStatus } from '../../shared/orch-types';
import { ChangeHub, makeId } from './store-util';

/**
 * Task store backing nexus_task — tracked background work items (optionally
 * attached to a mission) with create/update/list semantics.
 */

const tasks = new Map<string, TaskRecord>();
const hub = new ChangeHub();
let db: Db | null = null;

export function initTaskStore(database: Db | null): void {
  db = database;
  tasks.clear();
  if (!db) return;
  try {
    const rows = db.prepare('SELECT * FROM tasks').all() as Array<{
      id: string;
      mission_id: string | null;
      title: string;
      detail: string;
      status: string;
      created_at: number;
      updated_at: number;
    }>;
    for (const row of rows) {
      tasks.set(row.id, {
        id: row.id,
        missionId: row.mission_id ?? undefined,
        title: row.title,
        detail: row.detail,
        status: row.status as TaskStatus,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
  } catch (err) {
    console.warn('[orch] failed to hydrate tasks:', err);
  }
}

function persist(task: TaskRecord): void {
  if (!db) return;
  try {
    db.prepare(
      `INSERT OR REPLACE INTO tasks
         (id, mission_id, title, detail, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      task.id,
      task.missionId ?? null,
      task.title,
      task.detail,
      task.status,
      task.createdAt,
      task.updatedAt,
    );
  } catch (err) {
    console.warn('[orch] failed to persist task:', err);
  }
}

export function onTasksChange(cb: () => void): () => void {
  return hub.onChange(cb);
}

export function createTask(input: {
  title: string;
  detail?: string;
  missionId?: string;
}): TaskRecord {
  const now = Date.now();
  const task: TaskRecord = {
    id: makeId('task'),
    missionId: input.missionId,
    title: input.title,
    detail: input.detail ?? '',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  tasks.set(task.id, task);
  persist(task);
  hub.emit();
  return task;
}

export function updateTask(
  id: string,
  patch: { status?: TaskStatus; detail?: string; title?: string },
): TaskRecord | null {
  const existing = tasks.get(id);
  if (!existing) return null;
  const updated: TaskRecord = {
    ...existing,
    ...patch,
    updatedAt: Date.now(),
  };
  tasks.set(id, updated);
  persist(updated);
  hub.emit();
  return updated;
}

export function listTasks(missionId?: string): TaskRecord[] {
  const all = [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  return missionId ? all.filter((t) => t.missionId === missionId) : all;
}
