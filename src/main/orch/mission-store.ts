import { z } from 'zod';
import type Database from 'better-sqlite3';
import {
  canMarkMilestoneDone,
  missionIntentContractSchema,
  missionIntentStateSchema,
  missionMilestoneInputSchema,
  missionPatchSchema,
  missionStatusSchema,
  normalizeMilestones,
  structuralCoerceMilestones,
  type Mission,
  type MissionIntentContract,
  type MissionIntentState,
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
    intentState: missionIntentStateSchema.optional(),
    intentContract: missionIntentContractSchema.optional(),
    intentVersion: z.number().int().nonnegative().max(1_000_000).optional(),
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
    intent_state: missionIntentStateSchema.default('legacy'),
    intent_contract_json: z.string().nullable().optional(),
    intent_version: z.number().int().nonnegative().default(0),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

const milestoneJsonSchema = z.array(missionMilestoneInputSchema).max(256);
const entityIdSchema = z.string().min(1).max(256);
const sessionIdSchema = z.string().min(1).max(256);
const stepIdSchema = z.string().min(1).max(128);
const driverActionSchema = z.string().min(1).max(64);
const timestampSchema = z.number().int().nonnegative();

const missionDriveStateRowSchema = z
  .object({
    mission_id: entityIdSchema,
    revision: z.number().int().positive(),
    run_started_at: timestampSchema,
    attempt_count: z.number().int().nonnegative(),
    last_attempt_at: timestampSchema.nullable(),
    last_success_at: timestampSchema.nullable(),
    last_signal_at: timestampSchema.nullable(),
    last_action_kind: z.string().min(1).max(64).nullable(),
    last_outcome: z.enum(['reserved', 'success', 'failed']).nullable(),
    last_error: z.string().max(4096).nullable(),
    updated_at: timestampSchema,
  })
  .strict();

export type ScopedMission = ScopedEntity<Mission>;
export type CreateMissionInput = z.input<typeof createMissionInputSchema>;

export interface MissionDriveRuntimeState {
  readonly missionId: string;
  readonly revision: number;
  readonly runStartedAt: number;
  readonly attemptCount: number;
  readonly lastAttemptAt?: number;
  readonly lastSuccessAt?: number;
  readonly lastSignalAt?: number;
  readonly lastActionKind?: string;
  readonly lastOutcome?: 'reserved' | 'success' | 'failed';
  readonly lastError?: string;
  readonly updatedAt: number;
}

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
  return {
    ...mission,
    milestones: cloneMilestones(mission.milestones),
    ...(mission.intentContract
      ? {
          intentContract: {
            ...mission.intentContract,
            acceptanceCriteria: [...mission.intentContract.acceptanceCriteria],
            budgets: { ...mission.intentContract.budgets },
            deniedTools: mission.intentContract.deniedTools
              ? [...mission.intentContract.deniedTools]
              : undefined,
          },
        }
      : {}),
  };
}

function parseIntentContract(
  raw: string | null | undefined,
): MissionIntentContract | undefined {
  if (raw == null || raw === '') return undefined;
  try {
    return missionIntentContractSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new ScopedStoreCorruptionError('mission intent contract', {
      cause: error,
    });
  }
}

function serializeIntentContract(
  contract: MissionIntentContract | null | undefined,
): string | null {
  if (contract == null) return null;
  return JSON.stringify(contract);
}

function assertIntentContractRevision(
  contract: MissionIntentContract | undefined,
  intentVersion: number,
): void {
  if (contract && contract.intentVersion !== intentVersion) {
    throw new Error('mission intent contract version must match intentVersion');
  }
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

  getDriveRuntimeState(rawId: string): MissionDriveRuntimeState | null {
    const id = entityIdSchema.parse(rawId);
    const raw = this.#binding
      .readDatabase()
      .prepare(
        `SELECT mission_id, revision, run_started_at, attempt_count,
                last_attempt_at, last_success_at, last_signal_at,
                last_action_kind, last_outcome, last_error, updated_at
         FROM mission_drive_state WHERE mission_id = ?`,
      )
      .get(id);
    if (!raw) return null;
    try {
      const row = missionDriveStateRowSchema.parse(raw);
      return Object.freeze({
        missionId: row.mission_id,
        revision: row.revision,
        runStartedAt: row.run_started_at,
        attemptCount: row.attempt_count,
        ...(row.last_attempt_at === null
          ? {}
          : { lastAttemptAt: row.last_attempt_at }),
        ...(row.last_success_at === null
          ? {}
          : { lastSuccessAt: row.last_success_at }),
        ...(row.last_signal_at === null
          ? {}
          : { lastSignalAt: row.last_signal_at }),
        ...(row.last_action_kind === null
          ? {}
          : { lastActionKind: row.last_action_kind }),
        ...(row.last_outcome === null
          ? {}
          : { lastOutcome: row.last_outcome }),
        ...(row.last_error === null ? {} : { lastError: row.last_error }),
        updatedAt: row.updated_at,
      });
    } catch (error) {
      throw new ScopedStoreCorruptionError('mission drive state', {
        cause: error,
      });
    }
  }

  ensureDriveRuntimeState(
    rawId: string,
    rawStartedAt: number,
  ): MissionDriveRuntimeState {
    const id = entityIdSchema.parse(rawId);
    const startedAt = timestampSchema.parse(rawStartedAt);
    const db = this.#binding.writeDatabase();
    db.prepare(
      `INSERT OR IGNORE INTO mission_drive_state
         (mission_id, revision, run_started_at, attempt_count, updated_at)
       SELECT id, 1, ?, 0, ? FROM missions WHERE id = ?`,
    ).run(startedAt, startedAt, id);
    const state = this.getDriveRuntimeState(id);
    if (!state) throw new Error(`mission drive state requires mission ${id}`);
    return state;
  }

  reserveDriveAttempt(
    rawId: string,
    rawActionKind: string,
    rawAt: number,
  ): MissionDriveRuntimeState {
    const id = entityIdSchema.parse(rawId);
    const actionKind = driverActionSchema.parse(rawActionKind);
    const at = timestampSchema.parse(rawAt);
    const db = this.#binding.writeDatabase();
    db.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO mission_drive_state
           (mission_id, revision, run_started_at, attempt_count, updated_at)
         SELECT id, 1, ?, 0, ? FROM missions WHERE id = ?`,
      ).run(at, at, id);
      const result = db.prepare(
        `UPDATE mission_drive_state
         SET revision = revision + 1,
             attempt_count = attempt_count + 1,
             last_attempt_at = ?, last_action_kind = ?,
             last_outcome = 'reserved', last_error = NULL, updated_at = ?
         WHERE mission_id = ?`,
      ).run(at, actionKind, at, id);
      if (result.changes !== 1) {
        throw new Error(`mission drive attempt reservation failed for ${id}`);
      }
    })();
    return this.getDriveRuntimeState(id)!;
  }

  finishDriveAttempt(
    rawId: string,
    outcome: 'success' | 'failed',
    rawAt: number,
    rawError?: string,
  ): MissionDriveRuntimeState {
    const id = entityIdSchema.parse(rawId);
    const at = timestampSchema.parse(rawAt);
    const error = rawError?.slice(0, 4096) ?? null;
    const result = this.#binding
      .writeDatabase()
      .prepare(
        `UPDATE mission_drive_state
         SET revision = revision + 1,
             last_success_at = CASE WHEN ? = 'success' THEN ? ELSE last_success_at END,
             last_outcome = ?, last_error = ?, updated_at = ?
         WHERE mission_id = ? AND last_outcome = 'reserved'`,
      )
      .run(outcome, at, outcome, error, at, id);
    if (result.changes !== 1) {
      throw new Error(`mission drive attempt is not reserved for ${id}`);
    }
    return this.getDriveRuntimeState(id)!;
  }

  recordDriveSignal(rawId: string, rawAt: number): MissionDriveRuntimeState {
    const id = entityIdSchema.parse(rawId);
    const at = timestampSchema.parse(rawAt);
    const result = this.#binding
      .writeDatabase()
      .prepare(
        `UPDATE mission_drive_state
         SET revision = revision + 1, last_signal_at = ?, updated_at = ?
         WHERE mission_id = ?`,
      )
      .run(at, at, id);
    if (result.changes !== 1) {
      throw new Error(`mission drive state missing for ${id}`);
    }
    return this.getDriveRuntimeState(id)!;
  }

  create(rawInput: CreateMissionInput): ScopedMission {
    const input = createMissionInputSchema.parse(rawInput);
    const now = this.#binding.now();
    const intentState: MissionIntentState = input.intentState ?? 'legacy';
    const intentVersion = input.intentVersion ?? 0;
    assertIntentContractRevision(input.intentContract, intentVersion);
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
      intentState,
      ...(input.intentContract ? { intentContract: input.intentContract } : {}),
      intentVersion,
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
            learnings, orch_session_id, intent_state, intent_contract_json,
            intent_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        mission.intentState ?? 'legacy',
        serializeIntentContract(mission.intentContract),
        mission.intentVersion ?? 0,
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
                learnings, orch_session_id, intent_state, intent_contract_json,
                intent_version, created_at, updated_at
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
                    learnings, orch_session_id, intent_state, intent_contract_json,
                    intent_version, created_at, updated_at
             FROM missions WHERE status = ?
             ORDER BY created_at DESC, id ASC`,
          )
          .all(parsedStatus)
      : this.#binding
          .readDatabase()
          .prepare(
            `SELECT id, title, description, status, squad_id, milestones_json,
                    learnings, orch_session_id, intent_state, intent_contract_json,
                    intent_version, created_at, updated_at
             FROM missions ORDER BY created_at DESC, id ASC`,
          )
          .all();
    return rows.map((row) => this.#fromRow(row));
  }

  setOrchestratorSession(
    rawId: string,
    rawSessionId: string | null,
  ): ScopedMission | null {
    const id = entityIdSchema.parse(rawId);
    const sessionId =
      rawSessionId === null ? null : sessionIdSchema.parse(rawSessionId);
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
      const nextIntentContract =
        patch.intentContract === undefined
          ? existing.intentContract
          : patch.intentContract === null
            ? undefined
            : patch.intentContract;
      const next: ScopedMission = {
        ...existing,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.intentState !== undefined
          ? { intentState: patch.intentState }
          : {}),
        ...(patch.intentVersion !== undefined
          ? { intentVersion: patch.intentVersion }
          : {}),
        ...(patch.intentContract !== undefined
          ? nextIntentContract
            ? { intentContract: nextIntentContract }
            : { intentContract: undefined }
          : {}),
        milestones: nextMilestones,
        updatedAt: this.#binding.now(),
      };
      if (patch.intentContract === null) {
        delete next.intentContract;
      }
      assertIntentContractRevision(next.intentContract, next.intentVersion ?? 0);
      const result = db
        .prepare(
          `UPDATE missions
           SET title = ?, description = ?, status = ?, milestones_json = ?,
               intent_state = ?, intent_contract_json = ?, intent_version = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          next.title,
          next.description,
          next.status,
          JSON.stringify(next.milestones),
          next.intentState ?? 'legacy',
          serializeIntentContract(next.intentContract),
          next.intentVersion ?? 0,
          next.updatedAt,
          id,
        );
      if (
        result.changes === 1 &&
        next.status === 'running' &&
        existing.status !== 'running'
      ) {
        db.prepare(
          'DELETE FROM mission_drive_state WHERE mission_id = ?',
        ).run(id);
      }
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
    const db = this.#binding.writeDatabase();
    const result = db.transaction(() => {
      const existing = db
        .prepare('SELECT status FROM missions WHERE id = ?')
        .get(id) as { status: string } | undefined;
      if (!existing) return { changes: 0 };
      const update = db
        .prepare('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, this.#binding.now(), id);
      if (
        update.changes === 1 &&
        status === 'running' &&
        existing.status !== 'running'
      ) {
        db.prepare(
          'DELETE FROM mission_drive_state WHERE mission_id = ?',
        ).run(id);
      }
      return update;
    })();
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
    const intentContract = parseIntentContract(row.intent_contract_json);
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      squadId: row.squad_id ?? undefined,
      milestones: parseMilestones(row.milestones_json),
      learnings: row.learnings,
      intentState: row.intent_state,
      ...(intentContract ? { intentContract } : {}),
      intentVersion: row.intent_version,
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
