import { z } from 'zod';
import type Database from 'better-sqlite3';
import {
  canMarkMilestoneDone,
  missionMilestoneInputSchema,
  missionPatchSchema,
  missionStatusSchema,
  normalizeMilestones,
  structuralCoerceMilestones,
  type Mission,
  type MissionMilestone,
  type MissionPatch,
  type MissionStatus,
} from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedEntity,
  type ScopedStoreChangeListener,
  type ScopedStoreOptions,
} from './scoped-store';

const createMissionInputSchema = z
  .object({
    title: z.string().min(1).max(512),
    description: z.string().max(65_536).optional(),
    squadId: z.string().min(1).max(128).optional(),
    milestones: z.array(missionMilestoneInputSchema).max(256).optional(),
    orchestratorSessionId: z.string().min(1).max(256).optional(),
  })
  .strict();

const missionRowSchema = z
  .object({
    id: z.string().min(1).max(256),
    title: z.string().min(1).max(512),
    description: z.string().max(65_536),
    status: missionStatusSchema,
    squad_id: z.string().min(1).max(128).nullable(),
    milestones_json: z.string(),
    learnings: z.string().max(65_536),
    orch_session_id: z.string().min(1).max(256).nullable(),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

const milestoneJsonSchema = z.array(missionMilestoneInputSchema).max(256);
const entityIdSchema = z.string().min(1).max(256);
const sessionIdSchema = z.string().min(1).max(256);
const stepIdSchema = z.string().min(1).max(128);

export type ScopedMission = ScopedEntity<Mission>;
export type CreateMissionInput = z.input<typeof createMissionInputSchema>;

interface MissionRow extends z.infer<typeof missionRowSchema> {}

/**
 * Parse milestones_json: legacy string[], structured objects, or mixed.
 * Always returns structured MissionMilestone[] with structural done coercion.
 */
export function parseMilestones(raw: string): MissionMilestone[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    const inputs = milestoneJsonSchema.parse(parsed);
    return structuralCoerceMilestones(normalizeMilestones(inputs));
  } catch (error) {
    throw new ScopedStoreCorruptionError('mission milestones', { cause: error });
  }
}

function cloneMilestones(milestones: readonly MissionMilestone[]): MissionMilestone[] {
  return milestones.map((milestone) => ({
    ...milestone,
    evidenceIds: [...milestone.evidenceIds],
  }));
}

function cloneMission(mission: ScopedMission): ScopedMission {
  return { ...mission, milestones: cloneMilestones(mission.milestones) };
}

export class ScopedMissionStore {
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

  create(rawInput: CreateMissionInput): ScopedMission {
    const input = createMissionInputSchema.parse(rawInput);
    const now = this.#binding.now();
    const mission: ScopedMission = {
      id: this.#binding.makeId('mission'),
      title: input.title,
      description: input.description ?? '',
      status: 'pending',
      squadId: input.squadId,
      milestones: structuralCoerceMilestones(
        normalizeMilestones(input.milestones ?? []),
      ),
      learnings: '',
      orchestratorSessionId: input.orchestratorSessionId,
      createdAt: now,
      updatedAt: now,
      ...this.#binding.coordinates,
    };
    this.#binding
      .writeDatabase()
      .prepare(
        `INSERT INTO missions
           (id, title, description, status, squad_id, milestones_json,
            learnings, orch_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mission.id,
        mission.title,
        mission.description,
        mission.status,
        mission.squadId ?? null,
        JSON.stringify(mission.milestones),
        mission.learnings,
        mission.orchestratorSessionId ?? null,
        mission.createdAt,
        mission.updatedAt,
      );
    this.#binding.emitChange();
    return cloneMission(mission);
  }

  get(rawId: string): ScopedMission | null {
    const id = entityIdSchema.parse(rawId);
    return this.#getFromDatabase(this.#binding.readDatabase(), id);
  }

  #getFromDatabase(
    db: Database.Database,
    id: string,
  ): ScopedMission | null {
    const row = db
      .prepare(
        `SELECT id, title, description, status, squad_id, milestones_json,
                learnings, orch_session_id, created_at, updated_at
         FROM missions WHERE id = ?`,
      )
      .get(id);
    return row === undefined ? null : this.#fromRow(row);
  }

  list(status?: MissionStatus): ScopedMission[] {
    const parsedStatus = status === undefined ? undefined : missionStatusSchema.parse(status);
    const rows = parsedStatus
      ? this.#binding
          .readDatabase()
          .prepare(
            `SELECT id, title, description, status, squad_id, milestones_json,
                    learnings, orch_session_id, created_at, updated_at
             FROM missions WHERE status = ?
             ORDER BY created_at DESC, id ASC`,
          )
          .all(parsedStatus)
      : this.#binding
          .readDatabase()
          .prepare(
            `SELECT id, title, description, status, squad_id, milestones_json,
                    learnings, orch_session_id, created_at, updated_at
             FROM missions ORDER BY created_at DESC, id ASC`,
          )
          .all();
    return rows.map((row) => this.#fromRow(row));
  }

  setOrchestratorSession(
    rawId: string,
    rawSessionId: string,
  ): ScopedMission | null {
    const id = entityIdSchema.parse(rawId);
    const sessionId = sessionIdSchema.parse(rawSessionId);
    const result = this.#binding
      .writeDatabase()
      .prepare(
        `UPDATE missions
         SET orch_session_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(sessionId, this.#binding.now(), id);
    if (result.changes === 0) return null;
    this.#binding.emitChange();
    return this.get(id);
  }

  update(rawId: string, rawPatch: MissionPatch): ScopedMission | null {
    const id = entityIdSchema.parse(rawId);
    const patch = missionPatchSchema.parse(rawPatch);
    const db = this.#binding.writeDatabase();
    const updated = db.transaction(() => {
      const existing = this.#getFromDatabase(db, id);
      if (!existing) return null;
      const nextMilestones =
        patch.milestones !== undefined
          ? structuralCoerceMilestones(normalizeMilestones(patch.milestones))
          : cloneMilestones(existing.milestones);
      const next: ScopedMission = {
        ...existing,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        milestones: nextMilestones,
        updatedAt: this.#binding.now(),
      };
      const result = db
        .prepare(
          `UPDATE missions
           SET title = ?, description = ?, status = ?, milestones_json = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          next.title,
          next.description,
          next.status,
          JSON.stringify(next.milestones),
          next.updatedAt,
          id,
        );
      return result.changes === 1 ? next : null;
    })();
    if (!updated) return null;
    this.#binding.emitChange();
    return cloneMission(updated);
  }

  /**
   * Mark a step `done` only when every evidenceId is in the trusted set
   * (nexus-trusted). Otherwise returns the mission unchanged (step stays
   * non-done). This is the store-side gate used by the mission driver apply path.
   */
  markMilestoneDone(
    rawId: string,
    rawStepId: string,
    trustedEvidenceIds: ReadonlyArray<string>,
  ): ScopedMission | null {
    const id = entityIdSchema.parse(rawId);
    const stepId = stepIdSchema.parse(rawStepId);
    const trustSet = new Set(
      z.array(z.string().min(1).max(256)).max(256).parse([...trustedEvidenceIds]),
    );
    const db = this.#binding.writeDatabase();
    const updated = db.transaction(() => {
      const existing = this.#getFromDatabase(db, id);
      if (!existing) return null;
      const index = existing.milestones.findIndex((step) => step.id === stepId);
      if (index < 0) return existing;
      const step = existing.milestones[index]!;
      if (!canMarkMilestoneDone(step, trustSet)) {
        // Fail closed: stay non-done.
        return existing;
      }
      const nextMilestones = existing.milestones.map((milestone, i) =>
        i === index
          ? {
              ...milestone,
              status: 'done' as const,
              evidenceIds: [...milestone.evidenceIds],
            }
          : { ...milestone, evidenceIds: [...milestone.evidenceIds] },
      );
      const updatedAt = this.#binding.now();
      db.prepare(
        'UPDATE missions SET milestones_json = ?, updated_at = ? WHERE id = ?',
      ).run(JSON.stringify(nextMilestones), updatedAt, id);
      return { ...existing, milestones: nextMilestones, updatedAt };
    })();
    if (!updated) return null;
    this.#binding.emitChange();
    return cloneMission(updated);
  }

  /**
   * Anexa uma entrada ao markdown de learnings da missão (append-only). Insere
   * um separador de parágrafo entre entradas existentes; satura em 65_536 chars.
   * A seção "## Padrões" do topo é mantida/editada pelo consumidor (agente), não
   * por este método — aqui é só append cronológico. Bumps updated_at.
   */
  appendLearning(rawId: string, rawEntry: string): ScopedMission | null {
    const id = entityIdSchema.parse(rawId);
    const entry = z.string().min(1).max(65_536).parse(rawEntry);
    const db = this.#binding.writeDatabase();
    const updated = db.transaction(() => {
      const existing = this.#getFromDatabase(db, id);
      if (!existing) return null;
      const separator = existing.learnings.length > 0 ? '\n\n' : '';
      const nextLearnings = (
        existing.learnings + separator + entry
      ).slice(0, 65_536);
      const updatedAt = this.#binding.now();
      db.prepare(
        'UPDATE missions SET learnings = ?, updated_at = ? WHERE id = ?',
      ).run(nextLearnings, updatedAt, id);
      return { ...existing, learnings: nextLearnings, updatedAt };
    })();
    if (!updated) return null;
    this.#binding.emitChange();
    return cloneMission(updated);
  }

  remove(rawId: string): boolean {
    const id = entityIdSchema.parse(rawId);
    const result = this.#binding
      .writeDatabase()
      .prepare('DELETE FROM missions WHERE id = ?')
      .run(id);
    if (result.changes === 0) return false;
    this.#binding.emitChange();
    return true;
  }

  setStatus(rawId: string, rawStatus: MissionStatus): ScopedMission | null {
    const id = entityIdSchema.parse(rawId);
    const status = missionStatusSchema.parse(rawStatus);
    const result = this.#binding
      .writeDatabase()
      .prepare('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, this.#binding.now(), id);
    if (result.changes === 0) return null;
    this.#binding.emitChange();
    return this.get(id);
  }

  #fromRow(rawRow: unknown): ScopedMission {
    let row: MissionRow;
    try {
      row = missionRowSchema.parse(rawRow);
    } catch (error) {
      throw new ScopedStoreCorruptionError('mission', { cause: error });
    }
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      squadId: row.squad_id ?? undefined,
      milestones: parseMilestones(row.milestones_json),
      learnings: row.learnings,
      orchestratorSessionId: row.orch_session_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...this.#binding.coordinates,
    };
  }
}

export function createScopedMissionStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedStoreOptions = {},
): ScopedMissionStore {
  return new ScopedMissionStore(runtimeManager, scope, options);
}
