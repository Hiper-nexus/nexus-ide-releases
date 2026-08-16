import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import {
  missionResultSchema,
  type MissionResult,
} from '../../shared/mission-engine-contract';
import {
  canMarkMilestoneDone,
  isMissionRuntimeSquadId,
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
  type MissionPaneAuthoritySeal,
  type MissionPatch,
  type MissionStatus,
} from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { hasRetiredRosterRouteMarker } from '../../shared/retired-adapter-policy';
import {
  isMissionStatusIntentPair,
  hasCurrentApprovedDispatchContract,
  hasCurrentDispatchAuthority,
  missionBlockKindSchema,
  missionBlockPatch,
  resolveMissionBlockingIntentState,
  type MissionBlockKind,
} from '../../shared/mission-intent';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import type { RouteDecision } from './task-router';
import {
  MissionRouteReservationLedger,
  ROUTE_RESERVATION_TTL_MS,
  type MissionRouteReservation,
  type RouteReservationExpectation,
} from './mission-route-reservation-ledger';
import {
  MissionKickoffProofLedger,
  type MissionKickoffAcceptance,
  type RecordMissionKickoffAcceptance,
} from './mission-kickoff-proof-ledger';
import {
  MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_MARKER,
  MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_REASON,
  missionOrchestratorExitDescription,
  sanitizeMissionOrchestratorExitOutput,
  stripMissionOrchestratorExitDescription,
} from './mission-orchestrator-exit-policy';
import { hashMissionIntentAuthority } from './mission-pane-authority';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedEntity,
  type ScopedStoreChangeListener,
  type ScopedStoreOptions,
} from './scoped-store';

export { ROUTE_RESERVATION_TTL_MS };
export type {
  MissionKickoffAcceptance,
  MissionRouteReservation,
  RecordMissionKickoffAcceptance,
  RouteReservationExpectation,
};

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

export const missionContentPatchSchema = z
  .object({
    title: z.string().min(1).max(512).optional(),
    description: z.string().max(65_536).optional(),
    milestones: z.array(missionMilestoneInputSchema).max(256).optional(),
    intentContract: missionIntentContractSchema.nullable().optional(),
    intentVersion: z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .strict();
export type MissionContentPatch = z.infer<typeof missionContentPatchSchema>;

const missionRowSchema = z
  .object({
    id: z.string().min(1).max(256),
    title: z.string().min(1).max(512),
    description: z.string().max(65_536),
    status: missionStatusSchema,
    squad_id: z.string().min(1).max(128).nullable(),
    milestones_json: z.string(),
    learnings: z.string().max(65_536),
    result_json: z.string().nullable(),
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
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const stepIdSchema = z.string().min(1).max(128);
const driverActionSchema = z.string().min(1).max(64);
const timestampSchema = z.number().int().nonnegative();
const missionLifecycleExpectationSchema = z
  .object({
    updatedAt: timestampSchema.max(Number.MAX_SAFE_INTEGER),
    intentVersion: z.number().int().nonnegative().max(1_000_000),
  })
  .strict();
const missionLifecyclePatchSchema = z
  .object({
    status: missionStatusSchema,
    intentState: missionIntentStateSchema,
    description: z.string().max(65_536).optional(),
    learnings: z.string().max(65_536).optional(),
    intentContract: missionIntentContractSchema.optional(),
    result: missionResultSchema.optional(),
  })
  .strict();
const orchestratorPreDispatchExitInputSchema = z
  .object({
    missionId: entityIdSchema,
    orchestratorSessionId: sessionIdSchema,
    intentVersion: z.number().int().positive().max(1_000_000),
    intentContractHash: hashSchema,
    squadRevisionHash: hashSchema,
    observation: z.enum(['physical_exit', 'missing_session_reconcile']),
    outputTail: z.string().max(16_384),
  })
  .strict();

/**
 * Motivo de missão parada é diagnóstico, não payload: truncar mantém a linha
 * barata mesmo quando a origem concatena contexto longo.
 */
const STALL_REASON_MAX = 512;

/** Camada que explicou a parada — as duas decidem em ritmos diferentes. */
export type MissionStallReasonSource = 'driver-wait' | 'autopilot';

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
    last_wait_reason: z.string().max(STALL_REASON_MAX).nullable(),
    last_wait_reason_at: timestampSchema.nullable(),
    last_autopilot_reason: z.string().max(STALL_REASON_MAX).nullable(),
    last_autopilot_reason_at: timestampSchema.nullable(),
    updated_at: timestampSchema,
  })
  .strict();

export type ScopedMission = ScopedEntity<Mission>;
export type CreateMissionInput = z.input<typeof createMissionInputSchema>;
export type MissionRemovalResult = 'removed' | 'missing' | 'changed';

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
  /** Por que o driver decidiu `wait` da última vez que decidiu isso. */
  readonly lastWaitReason?: string;
  readonly lastWaitReasonAt?: number;
  /** Por que o autopilot do PREVC se declarou not-ready da última vez. */
  readonly lastAutopilotReason?: string;
  readonly lastAutopilotReasonAt?: number;
  readonly updatedAt: number;
}

export type OrchestratorPreDispatchExitInput = z.infer<
  typeof orchestratorPreDispatchExitInputSchema
>;

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
    ...(mission.result
      ? {
          result: {
            ...mission.result,
            evidenceIds: [...mission.result.evidenceIds],
            artifactRefs: [...mission.result.artifactRefs],
          },
        }
      : {}),
    ...(mission.intentContract
      ? {
          intentContract: {
            ...mission.intentContract,
            acceptanceCriteria: [...mission.intentContract.acceptanceCriteria],
            budgets: { ...mission.intentContract.budgets },
            deniedTools: mission.intentContract.deniedTools
              ? [...mission.intentContract.deniedTools]
              : undefined,
            attachmentPaths: mission.intentContract.attachmentPaths
              ? [...mission.intentContract.attachmentPaths]
              : undefined,
            attachmentSnapshots: mission.intentContract.attachmentSnapshots
              ? mission.intentContract.attachmentSnapshots.map((snapshot) => ({
                  ...snapshot,
                }))
              : undefined,
            promotedPlan: mission.intentContract.promotedPlan
              ? {
                  ...mission.intentContract.promotedPlan,
                  physicalReceipt: {
                    ...mission.intentContract.promotedPlan.physicalReceipt,
                  },
                  artifacts: structuredClone(
                    mission.intentContract.promotedPlan.artifacts,
                  ),
                }
              : undefined,
          },
        }
      : {}),
  };
}

function missionRemovalSnapshot(mission: Readonly<Mission>): object {
  return {
    id: mission.id,
    title: mission.title,
    description: mission.description,
    status: mission.status,
    squadId: mission.squadId ?? null,
    milestones: mission.milestones,
    learnings: mission.learnings,
    result: mission.result ?? null,
    orchestratorSessionId: mission.orchestratorSessionId ?? null,
    intentState: mission.intentState ?? null,
    intentContract: mission.intentContract ?? null,
    intentVersion: mission.intentVersion ?? 0,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
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

function parseMissionResult(
  raw: string | null | undefined,
): MissionResult | undefined {
  if (raw == null) return undefined;
  try {
    return missionResultSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new ScopedStoreCorruptionError('mission result', { cause: error });
  }
}

function serializeMissionResult(
  result: MissionResult | null | undefined,
): string | null {
  return result == null ? null : JSON.stringify(missionResultSchema.parse(result));
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
  readonly #kickoffProofs: MissionKickoffProofLedger;
  readonly #routeReservations: MissionRouteReservationLedger;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, options);
    this.#kickoffProofs = new MissionKickoffProofLedger(this.#binding);
    this.#routeReservations = new MissionRouteReservationLedger(this.#binding);
  }

  get scope(): ProjectExecutionScope {
    return this.#binding.scope;
  }

  onChange(listener: ScopedStoreChangeListener): () => void {
    return this.#binding.onChange(listener);
  }

  recordKickoffAcceptance(
    rawInput: RecordMissionKickoffAcceptance,
  ): MissionKickoffAcceptance {
    return this.#kickoffProofs.recordAcceptance(rawInput);
  }

  hasCurrentKickoffAcceptance(rawMissionId: string): boolean {
    return this.#kickoffProofs.hasCurrentAcceptance(rawMissionId);
  }

  hasExactCurrentKickoffAcceptance(
    rawInput: RecordMissionKickoffAcceptance,
  ): boolean {
    return this.#kickoffProofs.hasExactCurrentAcceptance(rawInput);
  }

  reserveRouteDecision(
    rawMissionId: string,
    rawTask: string,
    rawDecision: RouteDecision,
    rawTtlMs: number = ROUTE_RESERVATION_TTL_MS,
  ): MissionRouteReservation {
    return this.#routeReservations.reserveRouteDecision(
      rawMissionId,
      rawTask,
      rawDecision,
      rawTtlMs,
    );
  }

  getRouteReservation(
    rawReservationId: string,
  ): MissionRouteReservation | null {
    return this.#routeReservations.getRouteReservation(rawReservationId);
  }

  listOpenRouteAdapterIds(rawMissionId: string, rawAt?: number): string[] {
    return this.#routeReservations.listOpenRouteAdapterIds(
      rawMissionId,
      rawAt,
    );
  }

  assertRouteReservation(
    rawExpected: RouteReservationExpectation,
  ): MissionRouteReservation {
    return this.#routeReservations.assertRouteReservation(rawExpected);
  }

  consumeRouteReservation(
    rawExpected: RouteReservationExpectation,
    rawConsumerSessionId: string,
  ): MissionRouteReservation {
    return this.#routeReservations.consumeRouteReservation(
      rawExpected,
      rawConsumerSessionId,
    );
  }

  getDriveRuntimeState(rawId: string): MissionDriveRuntimeState | null {
    const id = entityIdSchema.parse(rawId);
    const raw = this.#binding
      .readDatabase()
      .prepare(
        `SELECT mission_id, revision, run_started_at, attempt_count,
                last_attempt_at, last_success_at, last_signal_at,
                last_action_kind, last_outcome, last_error,
                last_wait_reason, last_wait_reason_at,
                last_autopilot_reason, last_autopilot_reason_at, updated_at
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
        ...(row.last_wait_reason === null
          ? {}
          : { lastWaitReason: row.last_wait_reason }),
        ...(row.last_wait_reason_at === null
          ? {}
          : { lastWaitReasonAt: row.last_wait_reason_at }),
        ...(row.last_autopilot_reason === null
          ? {}
          : { lastAutopilotReason: row.last_autopilot_reason }),
        ...(row.last_autopilot_reason_at === null
          ? {}
          : { lastAutopilotReasonAt: row.last_autopilot_reason_at }),
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

  /**
   * Registra POR QUE a missão não avançou neste tick. É diagnóstico puro:
   * nunca toca `revision`, `attempt_count` nem `updated_at` — parar não é
   * tentativa e não pode consumir orçamento de recuperação nem parecer
   * progresso para quem observa `updated_at`.
   *
   * Só escreve quando o motivo MUDA. A 5s por tick, reescrever a mesma frase
   * centenas de vezes só gasta I/O; o valor está na transição (o motivo virou
   * outro) e no instante em que ela aconteceu.
   *
   * Devolve `true` quando gravou — o teste de regressão usa isso para provar
   * que a segunda chamada idêntica não escreveu.
   */
  recordDriveStallReason(
    rawId: string,
    source: MissionStallReasonSource,
    rawReason: string,
    rawAt?: number,
  ): boolean {
    const id = entityIdSchema.parse(rawId);
    const at = timestampSchema.parse(rawAt ?? this.#binding.now());
    const reason = rawReason.trim().slice(0, STALL_REASON_MAX);
    if (!reason) return false;
    const [column, columnAt] =
      source === 'driver-wait'
        ? ['last_wait_reason', 'last_wait_reason_at']
        : ['last_autopilot_reason', 'last_autopilot_reason_at'];
    const result = this.#binding
      .writeDatabase()
      .prepare(
        `UPDATE mission_drive_state
         SET ${column} = ?, ${columnAt} = ?
         WHERE mission_id = ?
           AND (${column} IS NULL OR ${column} <> ?)`,
      )
      .run(reason, at, id, reason);
    return result.changes === 1;
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
            learnings, result_json, orch_session_id, intent_state,
            intent_contract_json, intent_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mission.id,
        mission.title,
        mission.description,
        mission.status,
        mission.squadId ?? null,
        JSON.stringify(mission.milestones),
        mission.learnings,
        null,
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
                learnings, result_json, orch_session_id, intent_state,
                intent_contract_json, intent_version, created_at, updated_at
         FROM missions WHERE id = ?`,
      )
      .get(id);
    if (row === undefined) return null;
    return this.#routeReservations.withLatestRoute(db, this.#fromRow(row));
  }

  list(status?: MissionStatus): ScopedMission[] {
    const parsedStatus = status === undefined ? undefined : missionStatusSchema.parse(status);
    const rows = parsedStatus
      ? this.#binding
          .readDatabase()
          .prepare(
            `SELECT id, title, description, status, squad_id, milestones_json,
                    learnings, result_json, orch_session_id, intent_state,
                    intent_contract_json, intent_version, created_at, updated_at
             FROM missions WHERE status = ?
             ORDER BY created_at DESC, id ASC`,
          )
          .all(parsedStatus)
      : this.#binding
          .readDatabase()
          .prepare(
            `SELECT id, title, description, status, squad_id, milestones_json,
                    learnings, result_json, orch_session_id, intent_state,
                    intent_contract_json, intent_version, created_at, updated_at
             FROM missions ORDER BY created_at DESC, id ASC`,
          )
          .all();
    const db = this.#binding.readDatabase();
    return rows.map((row) =>
      this.#routeReservations.withLatestRoute(db, this.#fromRow(row)),
    );
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

  /**
   * Clears only the exact retired physical session. A concurrent rebind wins
   * the SQL CAS and can never be erased by a late teardown completion.
   */
  clearOrchestratorSessionIfMatches(
    rawId: string,
    rawExpectedSessionId: string,
  ): ScopedMission | null {
    const id = entityIdSchema.parse(rawId);
    const expectedSessionId = sessionIdSchema.parse(rawExpectedSessionId);
    const result = this.#binding
      .writeDatabase()
      .prepare(
        `UPDATE missions
         SET orch_session_id = NULL, updated_at = ?
         WHERE id = ? AND orch_session_id = ?`,
      )
      .run(this.#binding.now(), id, expectedSessionId);
    if (result.changes !== 1) return null;
    this.#binding.emitChange();
    return this.get(id);
  }

  /**
   * Commit an intentionally retired orchestrator binding after physical exit
   * proof. If the synchronous exit tap won the race and produced the exact
   * pre-dispatch block, heal that block in the same SQLite transaction.
   * Unrelated/user blocks are preserved and therefore cannot be overwritten
   * by a late teardown completion.
   */
  retireOrchestratorSessionForReplacement(
    rawId: string,
    rawExpectedSessionId: string,
    rawExpectedAuthoritySeal?: MissionPaneAuthoritySeal,
  ): ScopedMission | null {
    const id = entityIdSchema.parse(rawId);
    const expectedSessionId = sessionIdSchema.parse(rawExpectedSessionId);
    const expectedAuthoritySeal = rawExpectedAuthoritySeal
      ? {
          intentVersion: z.number().int().positive().max(1_000_000).parse(
            rawExpectedAuthoritySeal.intentVersion,
          ),
          intentContractHash: hashSchema.parse(
            rawExpectedAuthoritySeal.intentContractHash,
          ),
          squadRevisionHash: hashSchema.parse(
            rawExpectedAuthoritySeal.squadRevisionHash,
          ),
        }
      : undefined;
    const db = this.#binding.writeDatabase();
    const updated = db.transaction(() => {
      const current = this.#getFromDatabase(db, id);
      if (!current || current.orchestratorSessionId !== expectedSessionId) {
        return null;
      }
      const hasCurrentDispatch = Boolean(
        db.prepare(
          `SELECT 1
             FROM task_dispatch_queue
            WHERE mission_id = ?
              AND intent_version = ?
            LIMIT 1`,
        ).get(id, current.intentVersion ?? 0),
      );
      const hasExpectedAuthority =
        !expectedAuthoritySeal ||
        ((current.intentVersion ?? 0) ===
          expectedAuthoritySeal.intentVersion &&
        Boolean(
          current.intentContract &&
            hashMissionIntentAuthority(current.intentContract) ===
              expectedAuthoritySeal.intentContractHash &&
            current.intentContract.squadRevisionHash ===
              expectedAuthoritySeal.squadRevisionHash,
        ));
      const exitIdentityHash = createHash('sha256')
        .update(
          `${id}\0${current.intentVersion ?? 0}\0${expectedSessionId}`,
        )
        .digest('hex');
      const hasExactExitEvent = Boolean(
        db.prepare(
          `SELECT 1
             FROM mission_events
            WHERE mission_id = ?
              AND idempotency_key = ?
              AND event_type = 'agent.finished'
            LIMIT 1`,
        ).get(id, `orch-exit-${exitIdentityHash}`),
      );
      const shouldRearm =
        current.status === 'blocked' &&
        current.intentState === 'blocked_technical' &&
        current.description.includes(
          MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_MARKER,
        ) &&
        hasCurrentApprovedDispatchContract(current) &&
        hasExpectedAuthority &&
        hasExactExitEvent &&
        !hasCurrentDispatch;
      const nextStatus = shouldRearm ? 'running' : current.status;
      const nextIntentState = shouldRearm
        ? 'executing'
        : current.intentState ?? null;
      const nextDescription = shouldRearm
        ? stripMissionOrchestratorExitDescription(current.description)
        : current.description;
      const result = db.prepare(
        `UPDATE missions
            SET orch_session_id = NULL,
                status = ?,
                intent_state = ?,
                description = ?,
                updated_at = ?
          WHERE id = ?
            AND orch_session_id = ?
            AND updated_at = ?`,
      ).run(
        nextStatus,
        nextIntentState,
        nextDescription,
        this.#binding.now(),
        id,
        expectedSessionId,
        current.updatedAt,
      );
      if (result.changes !== 1) {
        throw new Error(
          'intentional orchestrator retirement lost mission CAS',
        );
      }
      return this.#getFromDatabase(db, id);
    }).immediate();
    if (!updated) return null;
    this.#binding.emitChange();
    return updated;
  }

  /**
   * Rebind a live orchestrator and recover completion-critical deliveries in
   * the same SQLite transaction. Accepted attempts remain immutable audit
   * evidence; only the handoff's delivery projection is queued for the new
   * physical session. Task dispatch/integration receipts are never rewritten.
   */
  rebindOrchestratorSession(
    rawId: string,
    rawSessionId: string,
  ): ScopedMission | null {
    const id = entityIdSchema.parse(rawId);
    const sessionId = sessionIdSchema.parse(rawSessionId);
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const found = db.transaction(() => {
      const mission = db.prepare(
        `SELECT description FROM missions WHERE id = ?`,
      ).get(id) as { description: string } | undefined;
      if (!mission) return false;

      const staleDeliveries = db.prepare(
        `SELECT h.id
         FROM handoffs AS h
         WHERE h.mission_id = ?
           AND h.status = 'success'
           AND h.delivered = 1
           AND EXISTS (
             SELECT 1 FROM handoff_delivery_attempts AS old_attempt
             WHERE old_attempt.handoff_id = h.id
               AND old_attempt.mission_id = h.mission_id
               AND old_attempt.state = 'accepted'
               AND old_attempt.accepted_at IS NOT NULL
               AND old_attempt.orchestrator_session_id <> ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM handoff_delivery_attempts AS current_attempt
             WHERE current_attempt.handoff_id = h.id
               AND current_attempt.mission_id = h.mission_id
               AND current_attempt.state = 'accepted'
               AND current_attempt.accepted_at IS NOT NULL
               AND current_attempt.orchestrator_session_id = ?
           )`,
      ).all(id, sessionId, sessionId) as Array<{ id: string }>;

      // Doutrina Overclock (2026-08-16): rebind é um ATO de recuperação —
      // nunca bloqueia a missão. A projeção de entrega é estado de transporte
      // de propriedade do Main: entrega aceita por sessão antiga vira fila
      // para a sessão nova, esteja ela em qualquer estado (inclusive sujo
      // por crash/timeout de escrita parcial). O outbox re-entrega.
      for (const handoff of staleDeliveries) {
        const requeued = db.prepare(
          `UPDATE handoffs
           SET delivered = 0, delivery_state = 'queued',
               submitted_at = NULL, acknowledged_at = NULL,
               consumed_at = NULL, consumed_by_session = NULL,
               consumed_delivery_attempt_id = NULL
           WHERE id = ? AND mission_id = ?`,
        ).run(handoff.id, id);
        if (requeued.changes !== 1) {
          throw new Error('orchestrator rebind lost handoff requeue');
        }
      }

      const updated = db.prepare(
        `UPDATE missions SET orch_session_id = ?, updated_at = ? WHERE id = ?`,
      ).run(sessionId, now, id);
      if (updated.changes !== 1) {
        throw new Error('orchestrator rebind lost mission CAS');
      }
      return true;
    }).immediate();
    if (!found) return null;
    this.#binding.emitChange();
    return this.get(id);
  }

  /**
   * Fail closed when the exact physical Maestro exits before creating the
   * first dispatch for this intent revision.
   *
   * The IMMEDIATE transaction fences session + revision + contract and proves
   * the absence of every dispatch. Both `dispatched` and `executing` are valid
   * current-authority states: Retomar rearms a blocked mission as `executing`
   * before the replacement Maestro boots. It deliberately also covers failure
   * before the kickoff receipt commits. Blocking plus the redacted diagnostic
   * event are one indivisible state change.
   */
  blockOrchestratorPreDispatchExit(
    rawInput: OrchestratorPreDispatchExitInput,
  ): ScopedMission | null {
    const input = orchestratorPreDispatchExitInputSchema.parse(rawInput);
    const outputTail = sanitizeMissionOrchestratorExitOutput(input.outputTail);
    const at = this.#binding.now();
    const identityHash = createHash('sha256')
      .update(
        `${input.missionId}\0${input.intentVersion}\0${input.orchestratorSessionId}`,
      )
      .digest('hex');
    const db = this.#binding.writeDatabase();
    const updated = db
      .transaction(() => {
        const current = this.#getFromDatabase(db, input.missionId);
        if (
          !current ||
          current.status !== 'running' ||
          !['dispatched', 'executing'].includes(current.intentState ?? '') ||
          current.orchestratorSessionId !== input.orchestratorSessionId ||
          (current.intentVersion ?? 0) !== input.intentVersion ||
          !hasCurrentDispatchAuthority(current) ||
          !current.intentContract ||
          hashMissionIntentAuthority(current.intentContract) !==
            input.intentContractHash ||
          current.intentContract.squadRevisionHash !== input.squadRevisionHash
        ) {
          return null;
        }

        const firstDispatch = db
          .prepare(
            `SELECT 1
               FROM task_dispatch_queue
              WHERE mission_id = ?
                AND intent_version = ?
              LIMIT 1`,
          )
          .get(input.missionId, input.intentVersion);
        if (firstDispatch) return null;

        const description = missionOrchestratorExitDescription(
          current.description,
        );
        const result = db
          .prepare(
            `UPDATE missions
                SET status = 'blocked',
                    intent_state = 'blocked_technical',
                    description = ?,
                    updated_at = ?
              WHERE id = ?
                AND status = 'running'
                AND intent_state IN ('dispatched', 'executing')
                AND intent_version = ?
                AND orch_session_id = ?`,
          )
          .run(
            description,
            at,
            input.missionId,
            input.intentVersion,
            input.orchestratorSessionId,
          );
        if (result.changes !== 1) {
          throw new Error(
            'orchestrator pre-dispatch exit lost mission authority CAS',
          );
        }

        db.prepare(
          `UPDATE mission_drive_state
              SET revision = revision + 1,
                  last_action_kind = 'orchestrator_exit',
                  last_outcome = 'failed',
                  last_error = ?,
                  updated_at = ?
            WHERE mission_id = ?`,
        ).run(
          MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_REASON,
          at,
          input.missionId,
        );

        const sequence = (
          db
            .prepare(
              `SELECT COALESCE(MAX(sequence), 0) + 1 AS value
                 FROM mission_events
                WHERE mission_id = ?`,
            )
            .get(input.missionId) as { value: number }
        ).value;
        db.prepare(
          `INSERT INTO mission_events (
             sequence, id, mission_id, run_id, parent_run_id, event_type,
             payload_json, idempotency_key, occurred_at, origin,
             delivery_status
           ) VALUES (?, ?, ?, ?, NULL, 'agent.finished', ?, ?, ?, 'system',
                     'pending')`,
        ).run(
          sequence,
          `mevt-orch-exit-${identityHash.slice(0, 40)}`,
          input.missionId,
          `orchestrator-${identityHash.slice(0, 40)}`,
          JSON.stringify({
            event: 'orchestrator.pre_dispatch_exit',
            reason: MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_REASON,
            sessionId: input.orchestratorSessionId,
            intentVersion: input.intentVersion,
            phase: 'before_first_dispatch',
            observation: input.observation,
            outputTail,
          }),
          `orch-exit-${identityHash}`,
          at,
        );

        return this.#getFromDatabase(db, input.missionId);
      })
      .immediate();
    if (!updated) return null;
    this.#binding.emitChange();
    return cloneMission(updated);
  }

  /**
   * Atomically replace a plan-only squad with its executable runtime snapshot
   * while advancing exactly one intent revision.
   *
   * This is deliberately not part of `MissionPatch`: renderer-owned updates
   * can never choose `squad_id`. The caller must present the exact main-owned
   * mission snapshot it reviewed after physical plan teardown; SQLite then
   * CASes id/squad/revision/timestamp and proves there is no live orchestrator
   * or task dispatch before publishing the standard-lane contract.
   */
  commitPlanPromotionRevision(
    rawId: string,
    expected: Mission,
    rawSquadId: string,
    rawContract: MissionIntentContract,
  ): ScopedMission {
    const id = entityIdSchema.parse(rawId);
    const squadId = z.string().min(1).max(128).parse(rawSquadId);
    const contract = missionIntentContractSchema.parse(rawContract);
    const expectedVersion = expected.intentVersion ?? 0;
    if (
      expected.id !== id ||
      expected.orchestratorSessionId !== undefined ||
      expected.intentContract?.lane !== 'plan' ||
      contract.lane !== 'standard' ||
      contract.intentVersion !== expectedVersion + 1
    ) {
      throw new Error('plan promotion revision contract is invalid');
    }
    assertIntentContractRevision(contract, contract.intentVersion);

    const db = this.#binding.writeDatabase();
    const updated = db.transaction(() => {
      const existing = this.#getFromDatabase(db, id);
      if (!existing) throw new Error('mission not found');
      const expectedContract = serializeIntentContract(expected.intentContract);
      const existingContract = serializeIntentContract(existing.intentContract);
      if (
        existing.squadId !== expected.squadId ||
        (existing.intentVersion ?? 0) !== expectedVersion ||
        existing.updatedAt !== expected.updatedAt ||
        existing.status !== expected.status ||
        (existing.intentState ?? 'legacy') !==
          (expected.intentState ?? 'legacy') ||
        existing.orchestratorSessionId !== undefined ||
        existingContract !== expectedContract
      ) {
        throw new Error('plan promotion mission CAS changed');
      }

      const activeDispatch = db.prepare(
        `SELECT task_id
           FROM task_dispatch_queue
          WHERE mission_id = ?
            AND state IN (
              'claimed', 'routed', 'spawning', 'running',
              'handoff_ready', 'merging', 'suspended'
            )
          LIMIT 1`,
      ).get(id);
      if (activeDispatch) {
        throw new Error(
          'plan promotion cannot replace squad while a task dispatch is active',
        );
      }

      const milestones = structuralCoerceMilestones(
        normalizeMilestones(contract.acceptanceCriteria),
      );
      const updatedAt = this.#binding.now();
      const result = db.prepare(
        `UPDATE missions
            SET squad_id = ?, status = 'pending', milestones_json = ?,
                intent_state = 'ready_to_start', intent_contract_json = ?,
                intent_version = ?, updated_at = ?
          WHERE id = ?
            AND intent_version = ?
            AND updated_at = ?
            AND orch_session_id IS NULL
            AND (
              (squad_id IS NULL AND ? IS NULL)
              OR squad_id = ?
            )`,
      ).run(
        squadId,
        JSON.stringify(milestones),
        serializeIntentContract(contract),
        contract.intentVersion,
        updatedAt,
        id,
        expectedVersion,
        expected.updatedAt,
        expected.squadId ?? null,
        expected.squadId ?? null,
      );
      if (result.changes !== 1) {
        throw new Error('plan promotion mission CAS changed');
      }
      return true;
    }).immediate();
    if (!updated) {
      throw new Error('plan promotion mission update failed');
    }
    this.#binding.emitChange();
    const mission = this.get(id);
    if (!mission) throw new Error('mission not found after plan promotion');
    return mission;
  }

  /**
   * Main-only: rebind a mission to an immutable `mission-runtime-*` /
   * `agentic-runtime-*` squad before approval hashes are sealed or while Main
   * repairs a degraded authority snapshot. An optional replacement contract
   * is committed in the same SQLite CAS so id and revision hash cannot tear.
   *
   * Deliberately outside `MissionPatch` so the renderer cannot choose
   * `squad_id`. Builtins stay free to evolve via `syncBuiltins()`; in-flight
   * missions keep reading the pinned runtime copy.
   */
  bindMissionRuntimeSquad(
    rawId: string,
    expected: Mission,
    rawSquadId: string,
    rawContract?: MissionIntentContract,
  ): ScopedMission {
    const squadId = z.string().min(1).max(128).parse(rawSquadId);
    if (!isMissionRuntimeSquadId(squadId)) {
      throw new Error('mission runtime squad binding requires a runtime id');
    }
    return this.#bindMissionSquadAuthority(
      rawId,
      expected,
      squadId,
      rawContract,
    );
  }

  /**
   * Main-only D1 repair for a missing/stale squad. Unlike approval pinning,
   * the best available fallback may be a live catalog roster. The caller must
   * supply the matching approved-contract hash and both values land in one CAS.
   */
  rebindMissionSquadAuthority(
    rawId: string,
    expected: Mission,
    rawSquadId: string,
    rawContract: MissionIntentContract,
  ): ScopedMission {
    const squadId = z.string().min(1).max(128).parse(rawSquadId);
    return this.#bindMissionSquadAuthority(
      rawId,
      expected,
      squadId,
      missionIntentContractSchema.parse(rawContract),
    );
  }

  #bindMissionSquadAuthority(
    rawId: string,
    expected: Mission,
    squadId: string,
    rawContract?: MissionIntentContract,
  ): ScopedMission {
    const id = entityIdSchema.parse(rawId);
    const nextContract =
      rawContract === undefined
        ? expected.intentContract
        : missionIntentContractSchema.parse(rawContract);
    assertIntentContractRevision(nextContract, expected.intentVersion ?? 0);
    if (expected.id !== id) {
      throw new Error('mission runtime squad binding target mismatch');
    }
    if (
      expected.squadId === squadId &&
      serializeIntentContract(nextContract) ===
        serializeIntentContract(expected.intentContract)
    ) {
      const current = this.get(id);
      if (!current) throw new Error('mission not found');
      return current;
    }

    const db = this.#binding.writeDatabase();
    const updated = db
      .transaction(() => {
        const existing = this.#getFromDatabase(db, id);
        if (!existing) throw new Error('mission not found');
        if (
          existing.squadId !== expected.squadId ||
          (existing.intentVersion ?? 0) !== (expected.intentVersion ?? 0) ||
          existing.updatedAt !== expected.updatedAt ||
          existing.status !== expected.status ||
          serializeIntentContract(existing.intentContract) !==
            serializeIntentContract(expected.intentContract)
        ) {
          throw new Error('mission runtime squad binding CAS changed');
        }
        const updatedAt = this.#binding.now();
        const result = db
          .prepare(
            `UPDATE missions
              SET squad_id = ?, intent_contract_json = ?, updated_at = ?
            WHERE id = ?
              AND updated_at = ?
              AND (
                (squad_id IS NULL AND ? IS NULL)
                OR squad_id = ?
              )`,
          )
          .run(
            squadId,
            serializeIntentContract(nextContract),
            updatedAt,
            id,
            expected.updatedAt,
            expected.squadId ?? null,
            expected.squadId ?? null,
          );
        if (result.changes !== 1) {
          throw new Error('mission runtime squad binding CAS changed');
        }
        return true;
      })
      .immediate();
    if (!updated) {
      throw new Error('mission runtime squad binding failed');
    }
    this.#binding.emitChange();
    const mission = this.get(id);
    if (!mission) {
      throw new Error('mission not found after runtime squad binding');
    }
    return mission;
  }

  /**
   * Publish a fresh, human-reviewable revision after an already-dispatched
   * task graph became terminally invalid.
   *
   * The old task plan, task rows, dispatch queue and every receipt are audit
   * history and are intentionally left untouched. The caller must first prove
   * physical pane/session teardown and remove the durable pane composition;
   * this transaction then CASes the exact blocked mission snapshot, requires a
   * terminal dispatch from that same revision, or the explicit retired-route
   * marker produced before a claim could exist, and advances exactly once.
   */
  publishDeadGraphReapprovalRevision(
    rawId: string,
    expected: Mission,
  ): ScopedMission {
    const id = entityIdSchema.parse(rawId);
    const expectedVersion = expected.intentVersion ?? 0;
    const expectedContract = expected.intentContract;
    // Field trap (28/07): requiring the intentState to also be blocked_* made
    // the inconsistent pair `blocked` + `dispatched` fail here with an opaque
    // "contract is invalid", leaving the mission wedged. `status === 'blocked'`
    // is the authority; a stale intent pair is exactly what this transaction
    // heals. Only a finished mission stays out.
    if (
      expected.id !== id ||
      expected.status !== 'blocked' ||
      expected.intentState === 'done' ||
      !expectedContract ||
      expectedContract.intentVersion !== expectedVersion ||
      expectedVersion <= 0 ||
      expectedVersion >= 1_000_000 ||
      expectedContract.approvedAt === undefined
    ) {
      throw new Error('dead graph reapproval contract is invalid');
    }

    const {
      approvedAt: _approvedAt,
      approvalReviewSha256: _approvalReviewSha256,
      dispatchedAt: _dispatchedAt,
      squadRevisionHash: _squadRevisionHash,
      orchestratorRuntime: _orchestratorRuntime,
      spentSteps: _spentSteps,
      spentTokens: _spentTokens,
      ...reusableContract
    } = expectedContract;
    const nextVersion = expectedVersion + 1;
    const nextContract = missionIntentContractSchema.parse({
      ...reusableContract,
      intentVersion: nextVersion,
    });
    const nextMilestones = structuralCoerceMilestones(
      normalizeMilestones(nextContract.acceptanceCriteria),
    );
    const serializedExpectedContract = serializeIntentContract(expectedContract);
    const serializedNextContract = serializeIntentContract(nextContract);
    const db = this.#binding.writeDatabase();
    const updated = db
      .transaction(() => {
        const current = this.#getFromDatabase(db, id);
        if (
          !current ||
          current.status !== expected.status ||
          (current.intentState ?? 'legacy') !==
            (expected.intentState ?? 'legacy') ||
          (current.intentVersion ?? 0) !== expectedVersion ||
          current.updatedAt !== expected.updatedAt ||
          current.squadId !== expected.squadId ||
          current.orchestratorSessionId !== expected.orchestratorSessionId ||
          serializeIntentContract(current.intentContract) !==
            serializedExpectedContract
        ) {
          throw new Error('dead graph reapproval mission CAS changed');
        }

        const persistedPane = db
          .prepare(
            `SELECT id FROM mission_panes
             WHERE mission_id = ?
             LIMIT 1`,
          )
          .get(id);
        if (persistedPane) {
          throw new Error(
            'dead graph reapproval requires proven pane teardown',
          );
        }

        const invalidatedDispatch = db
          .prepare(
            `SELECT task_id FROM task_dispatch_queue
             WHERE mission_id = ?
               AND intent_version = ?
               AND state IN ('superseded', 'blocked', 'failed')
             LIMIT 1`,
          )
          .get(id, expectedVersion);
        const retiredRouteInvalidated = hasRetiredRosterRouteMarker(
          current.description,
        );
        if (!invalidatedDispatch && !retiredRouteInvalidated) {
          throw new Error(
            'dead graph reapproval requires an invalidated current dispatch',
          );
        }
        const nonTerminalDispatch = db
          .prepare(
            `SELECT task_id FROM task_dispatch_queue
             WHERE mission_id = ?
               AND intent_version = ?
               AND state NOT IN (
                 'completed', 'superseded', 'blocked', 'failed'
               )
             LIMIT 1`,
          )
          .get(id, expectedVersion);
        if (nonTerminalDispatch) {
          throw new Error(
            'dead graph reapproval cannot advance a non-terminal dispatch',
          );
        }

        const updatedAt = this.#binding.now();
        const result = db
          .prepare(
            `UPDATE missions
             SET status = 'pending',
                 milestones_json = ?,
                 orch_session_id = NULL,
                 -- Gate de aprovação removido do caminho normal (06/08): a
                 -- revisão republicada nasce DESPACHÁVEL, não estacionada.
                 intent_state = 'ready_to_start',
                 intent_contract_json = ?,
                 intent_version = ?,
                 updated_at = ?
             WHERE id = ?
               AND status = 'blocked'
               AND intent_state = ?
               AND intent_version = ?
               AND updated_at = ?
               AND intent_contract_json = ?
               AND (
                 (orch_session_id IS NULL AND ? IS NULL)
                 OR orch_session_id = ?
               )`,
          )
          .run(
            JSON.stringify(nextMilestones),
            serializedNextContract,
            nextVersion,
            updatedAt,
            id,
            expected.intentState,
            expectedVersion,
            expected.updatedAt,
            serializedExpectedContract,
            expected.orchestratorSessionId ?? null,
            expected.orchestratorSessionId ?? null,
          );
        if (result.changes !== 1) {
          throw new Error('dead graph reapproval mission CAS changed');
        }
        return this.#getFromDatabase(db, id);
      })
      .immediate();
    if (!updated) {
      throw new Error('dead graph reapproval mission update failed');
    }
    this.#binding.emitChange();
    return cloneMission(updated);
  }

  transitionLifecycle(
    rawId: string,
    rawExpectation: {
      readonly updatedAt: number;
      readonly intentVersion: number;
    },
    rawPatch: {
      readonly status: MissionStatus;
      readonly intentState: MissionIntentState;
      readonly description?: string;
      readonly learnings?: string;
      readonly intentContract?: MissionIntentContract;
      readonly result?: MissionResult;
    },
  ): ScopedMission | null {
    const id = entityIdSchema.parse(rawId);
    const expectation = missionLifecycleExpectationSchema.parse(rawExpectation);
    const patch = missionLifecyclePatchSchema.parse(rawPatch);
    if (!isMissionStatusIntentPair(patch)) {
      throw new Error(
        `invalid lifecycle pair: ${patch.status}/${patch.intentState}`,
      );
    }
    if (patch.status === 'done' && patch.result === undefined) {
      throw new Error('terminal mission completion requires a canonical result');
    }
    const db = this.#binding.writeDatabase();
    const nestedTransaction = db.inTransaction;
    const applyTransition = (): ScopedMission | null => {
        const existing = this.#getFromDatabase(db, id);
        if (!existing) return null;
        const nextIntentContract =
          patch.intentContract ?? existing.intentContract;
        assertIntentContractRevision(
          nextIntentContract,
          expectation.intentVersion,
        );
        const updatedAt = Math.max(
          this.#binding.now(),
          expectation.updatedAt + 1,
        );
        if (!Number.isSafeInteger(updatedAt)) {
          throw new Error('mission updatedAt cannot advance monotonically');
        }
        const nextResult =
          patch.status === 'done'
            ? (patch.result ?? existing.result)
            : undefined;
        const result = db
          .prepare(
            `UPDATE missions
             SET status = ?, intent_state = ?, description = ?, learnings = ?,
                 result_json = ?, intent_contract_json = ?, updated_at = ?
             WHERE id = ? AND updated_at = ? AND intent_version = ?`,
          )
          .run(
            patch.status,
            patch.intentState,
            patch.description ?? existing.description,
            patch.learnings ?? existing.learnings,
            serializeMissionResult(nextResult),
            serializeIntentContract(nextIntentContract),
            updatedAt,
            id,
            expectation.updatedAt,
            expectation.intentVersion,
          );
        if (result.changes !== 1) return null;

        const lifecycleRevoked =
          patch.status === 'blocked' ||
          patch.status === 'failed' ||
          patch.intentState === 'blocked_user' ||
          patch.intentState === 'blocked_technical';
        if (lifecycleRevoked) {
          const detail =
            'A missão foi bloqueada ou falhou; a autoridade deste worker foi revogada.';
          db.prepare(
            `UPDATE tasks SET status = 'failed', updated_at = ?
             WHERE id IN (
               SELECT task_id FROM task_dispatch_queue
               WHERE mission_id = ?
                 AND state IN (
                   'claimed', 'routed', 'spawning', 'running',
                   'handoff_ready', 'merging', 'suspended'
                 )
             )`,
          ).run(updatedAt, id);
          db.prepare(
            `UPDATE task_dispatch_queue
             SET state = 'superseded', last_error = ?, revision = revision + 1,
                 updated_at = ?
             WHERE mission_id = ?
               AND state IN (
                 'claimed', 'routed', 'spawning', 'running',
                 'handoff_ready', 'merging', 'suspended'
               )`,
          ).run(detail, updatedAt, id);
        }
        if (patch.status === 'running' && existing.status !== 'running') {
          db.prepare(
            'DELETE FROM mission_drive_state WHERE mission_id = ?',
          ).run(id);
        }
        return this.#getFromDatabase(db, id);
    };
    const updated = nestedTransaction
      ? applyTransition()
      : db.transaction(applyTransition).immediate();
    if (!updated) return null;
    if (nestedTransaction) {
      const committedUpdatedAt = updated.updatedAt;
      queueMicrotask(() => {
        const committed = this.get(id);
        if (
          committed?.updatedAt === committedUpdatedAt &&
          committed.status === updated.status &&
          committed.intentState === updated.intentState
        ) {
          this.#binding.emitChange();
        }
      });
    } else {
      this.#binding.emitChange();
    }
    return cloneMission(updated);
  }

  updateContent(
    rawId: string,
    rawPatch: MissionContentPatch,
  ): ScopedMission | null {
    const patch = missionContentPatchSchema.parse(rawPatch);
    return this.update(rawId, patch);
  }

  update(rawId: string, rawPatch: MissionPatch): ScopedMission | null {
    const id = entityIdSchema.parse(rawId);
    const patch = missionPatchSchema.parse(rawPatch);
    if (patch.status === 'done') {
      throw new Error(
        'verified completion must be committed through MissionEngine authority',
      );
    }
    const db = this.#binding.writeDatabase();
    const updated = db
      .transaction(() => {
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
        let next: ScopedMission = {
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
        const blockingIntentState = resolveMissionBlockingIntentState({
          status: next.status,
          intentState: next.intentState,
        });
        if (blockingIntentState) {
          next = { ...next, intentState: blockingIntentState };
        } else if (
          next.status !== 'blocked' &&
          next.status !== 'failed' &&
          next.status !== 'done' &&
          (next.intentState === 'blocked_technical' ||
            next.intentState === 'blocked_user')
        ) {
          // Split-brain guard (2026-08-16): um write status-only de reativação
          // (nexus_mission_set_status, delegation-supervisor, resume parcial)
          // não pode deixar intent de bloqueio numa missão viva —
          // hasCurrentDispatchAuthority morre (canDispatchWorkers=false) e o
          // reconciler de 1s mata qualquer runtime respawnado. Missão viva
          // que herda intent de bloqueio volta como 'executing' (a mesma
          // semântica documentada do Retomar).
          next = { ...next, intentState: 'executing' };
        }
        if (patch.intentContract === null) {
          delete next.intentContract;
        }
        if (next.status !== 'done') {
          delete next.result;
        }
        assertIntentContractRevision(
          next.intentContract,
          next.intentVersion ?? 0,
        );
        const intentChanged =
          (next.intentVersion ?? 0) !== (existing.intentVersion ?? 0);
        const activeDispatches = db
          .prepare(
            `SELECT task_id, intent_version FROM task_dispatch_queue
         WHERE mission_id = ?
           AND state IN (
             'claimed', 'routed', 'spawning', 'running',
             'handoff_ready', 'merging', 'suspended'
           )`,
      ).all(id) as Array<{ task_id: string; intent_version: number }>;
      const staleDispatches = intentChanged
        ? activeDispatches.filter(
            (dispatch) => dispatch.intent_version !== (next.intentVersion ?? 0),
          )
        : [];
      if (staleDispatches.length > 0) {
        const marker = '[NEXUS_INTENT_SUPERSEDED]';
        const detail =
          'A intenção da missão mudou enquanto havia um worker em execução. ' +
          'O resultado antigo foi invalidado para não concluir um contrato diferente.';
        const cta =
          `${marker}\n## Execução anterior invalidada\n${detail}\n` +
          'Clique em “Retomar missão” para revisar o plano e despachar novos workers.';
        next = {
          ...next,
          status: 'blocked',
          intentState: 'blocked_technical',
          description: next.description.includes(marker)
            ? next.description
            : (next.description.trim()
                ? `${next.description}\n\n${cta}`
                : cta).slice(0, 65_536),
        };
      }
      const lifecycleRevoked =
        next.status === 'blocked' ||
        next.status === 'failed' ||
        next.intentState === 'blocked_user' ||
        next.intentState === 'blocked_technical';
      const invalidatedDispatches = lifecycleRevoked
        ? activeDispatches
        : staleDispatches;
      const result = db
        .prepare(
          `UPDATE missions
           SET title = ?, description = ?, status = ?, milestones_json = ?,
               result_json = ?, intent_state = ?, intent_contract_json = ?,
               intent_version = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          next.title,
          next.description,
          next.status,
          JSON.stringify(next.milestones),
          serializeMissionResult(next.result),
          next.intentState ?? 'legacy',
          serializeIntentContract(next.intentContract),
          next.intentVersion ?? 0,
          next.updatedAt,
          id,
        );
      if (result.changes === 1 && invalidatedDispatches.length > 0) {
        const detail = lifecycleRevoked
          ? 'A missão foi bloqueada ou falhou; a autoridade deste worker foi revogada.'
          : 'A intenção da missão mudou; este worker não possui autoridade para a nova versão.';
        const versionPredicate = lifecycleRevoked
          ? ''
          : 'AND intent_version <> ?';
        const predicateArgs = lifecycleRevoked
          ? [id]
          : [id, next.intentVersion ?? 0];
        db.prepare(
          `UPDATE tasks SET status = 'failed', updated_at = ?
           WHERE id IN (
             SELECT task_id FROM task_dispatch_queue
             WHERE mission_id = ? ${versionPredicate}
               AND state IN (
                 'claimed', 'routed', 'spawning', 'running',
                 'handoff_ready', 'merging', 'suspended'
               )
           )`,
        ).run(next.updatedAt, ...predicateArgs);
        db.prepare(
          `UPDATE task_dispatch_queue
           SET state = 'superseded', last_error = ?, revision = revision + 1,
               updated_at = ?
           WHERE mission_id = ? ${versionPredicate}
             AND state IN (
               'claimed', 'routed', 'spawning', 'running',
               'handoff_ready', 'merging', 'suspended'
             )`,
        ).run(detail, next.updatedAt, ...predicateArgs);
      }
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
    }).immediate();
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

  /**
   * Deletes only the exact durable revision observed by the caller.
   *
   * The read/compare/delete runs in one IMMEDIATE SQLite transaction, closing
   * the gap where recovery or another Main writer could re-arm the mission
   * after physical teardown but before an unconditional DELETE.
   */
  removeIfUnchanged(
    rawId: string,
    expected: Readonly<Mission>,
  ): MissionRemovalResult {
    const id = entityIdSchema.parse(rawId);
    if (expected.id !== id) {
      throw new Error('mission removal expectation id mismatch');
    }
    const db = this.#binding.writeDatabase();
    const outcome = db
      .transaction((): MissionRemovalResult => {
        const current = this.#getFromDatabase(db, id);
        if (!current) return 'missing';
        if (
          !isDeepStrictEqual(
            missionRemovalSnapshot(current),
            missionRemovalSnapshot(expected),
          )
        ) {
          return 'changed';
        }
        const result = db
          .prepare('DELETE FROM missions WHERE id = ?')
          .run(id);
        if (result.changes !== 1) {
          throw new Error('mission removal CAS failed after exact comparison');
        }
        return 'removed';
      })
      .immediate();
    if (outcome === 'removed') this.#binding.emitChange();
    return outcome;
  }

  setStatus(rawId: string, rawStatus: MissionStatus): ScopedMission | null {
    const id = entityIdSchema.parse(rawId);
    const status = missionStatusSchema.parse(rawStatus);
    return this.update(id, { status });
  }


  /** Persist a typed user/technical block without an ambiguous status-only write. */
  block(rawId: string, rawKind: MissionBlockKind): ScopedMission | null {
    const kind = missionBlockKindSchema.parse(rawKind);
    return this.update(rawId, missionBlockPatch(kind));
  }

  #fromRow(rawRow: unknown): ScopedMission {
    let row: MissionRow;
    try {
      row = missionRowSchema.parse(rawRow);
    } catch (error) {
      throw new ScopedStoreCorruptionError('mission', { cause: error });
    }
    const intentContract = parseIntentContract(row.intent_contract_json);
    const missionResult = parseMissionResult(row.result_json);
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      squadId: row.squad_id ?? undefined,
      milestones: parseMilestones(row.milestones_json),
      learnings: row.learnings,
      ...(missionResult ? { result: missionResult } : {}),
      // Migração 06/08 (gate de aprovação removido do caminho normal): linhas
      // estacionadas em awaiting_approval soltam NA LEITURA para
      // ready_to_start — idempotente, sem write de migração; o próximo update
      // persiste o estado novo naturalmente.
      intentState:
        row.intent_state === 'awaiting_approval'
          ? 'ready_to_start'
          : row.intent_state,
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
