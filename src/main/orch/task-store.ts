import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { TaskRecord, TaskStatus } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedEntity,
  type ScopedStoreChangeListener,
  type ScopedStoreOptions,
} from './scoped-store';

const taskStatusSchema = z.enum(['pending', 'running', 'done', 'failed']);
const entityIdSchema = z.string().min(1).max(256);

const createTaskInputSchema = z
  .object({
    title: z.string().min(1).max(1_024),
    detail: z.string().max(65_536).optional(),
    missionId: entityIdSchema.optional(),
  })
  .strict();

const taskPatchSchema = z
  .object({
    status: taskStatusSchema.optional(),
    detail: z.string().max(65_536).optional(),
    title: z.string().min(1).max(1_024).optional(),
  })
  .strict();

const taskRowSchema = z
  .object({
    id: entityIdSchema,
    mission_id: entityIdSchema.nullable(),
    title: z.string().min(1).max(1_024),
    detail: z.string().max(65_536),
    status: taskStatusSchema,
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

export type ScopedTaskRecord = ScopedEntity<TaskRecord>;
export type CreateTaskInput = z.input<typeof createTaskInputSchema>;
export type TaskPatch = z.input<typeof taskPatchSchema>;

export class ScopedTaskStore {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, options);
  }

  get scope(): ProjectExecutionScope {
    return this.#binding.scope;
  }

  onChange(listener: ScopedStoreChangeListener): () => void {
    return this.#binding.onChange(listener);
  }

  create(rawInput: CreateTaskInput): ScopedTaskRecord {
    const input = createTaskInputSchema.parse(rawInput);
    const now = this.#binding.now();
    const task: ScopedTaskRecord = {
      id: this.#binding.makeId('task'),
      missionId: input.missionId,
      title: input.title,
      detail: input.detail ?? '',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      ...this.#binding.coordinates,
    };
    this.#binding
      .writeDatabase()
      .prepare(
        `INSERT INTO tasks
           (id, mission_id, title, detail, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.missionId ?? null,
        task.title,
        task.detail,
        task.status,
        task.createdAt,
        task.updatedAt,
      );
    this.#binding.emitChange();
    return { ...task };
  }

  update(rawId: string, rawPatch: TaskPatch): ScopedTaskRecord | null {
    const id = entityIdSchema.parse(rawId);
    const patch = taskPatchSchema.parse(rawPatch);
    const db = this.#binding.writeDatabase();
    const updated = db.transaction(() => {
      const existing = this.#getFromDatabase(db, id);
      if (!existing) return null;
      const next: ScopedTaskRecord = {
        ...existing,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        updatedAt: this.#binding.now(),
      };
      const result = db
        .prepare(
          `UPDATE tasks
           SET title = ?, detail = ?, status = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(next.title, next.detail, next.status, next.updatedAt, id);
      return result.changes === 1 ? next : null;
    })();
    if (!updated) return null;
    this.#binding.emitChange();
    return { ...updated };
  }

  list(rawMissionId?: string): ScopedTaskRecord[] {
    const missionId =
      rawMissionId === undefined ? undefined : entityIdSchema.parse(rawMissionId);
    const db = this.#binding.readDatabase();
    const rows = missionId
      ? db
          .prepare(
            `SELECT id, mission_id, title, detail, status, created_at,
                    updated_at
             FROM tasks WHERE mission_id = ?
             ORDER BY created_at DESC, id ASC`,
          )
          .all(missionId)
      : db
          .prepare(
            `SELECT id, mission_id, title, detail, status, created_at,
                    updated_at
             FROM tasks ORDER BY created_at DESC, id ASC`,
          )
          .all();
    return rows.map((row) => this.#fromRow(row));
  }

  #getFromDatabase(
    db: Database.Database,
    id: string,
  ): ScopedTaskRecord | null {
    const row = db
      .prepare(
        `SELECT id, mission_id, title, detail, status, created_at, updated_at
         FROM tasks WHERE id = ?`,
      )
      .get(id);
    return row === undefined ? null : this.#fromRow(row);
  }

  #fromRow(rawRow: unknown): ScopedTaskRecord {
    let row: z.infer<typeof taskRowSchema>;
    try {
      row = taskRowSchema.parse(rawRow);
    } catch (error) {
      throw new ScopedStoreCorruptionError('task', { cause: error });
    }
    return {
      id: row.id,
      missionId: row.mission_id ?? undefined,
      title: row.title,
      detail: row.detail,
      status: row.status as TaskStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...this.#binding.coordinates,
    };
  }
}

export function createScopedTaskStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedStoreOptions = {},
): ScopedTaskStore {
  return new ScopedTaskStore(runtimeManager, scope, options);
}
