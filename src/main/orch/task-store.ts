import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  agentCategorySchema,
  squadAgentSchema,
  type AgentCategory,
  type SquadAgent,
  type TaskRecord,
  type TaskStatus,
} from '../../shared/orch-types';
import { missionIntentContractSchema } from '../../shared/mission-intent';
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

const plannedTaskRowSchema = z.object({
  plannerId: entityIdSchema,
  title: z.string().min(1).max(1_024),
  detail: z.string().max(65_536),
  agentRef: entityIdSchema,
  agentCategory: agentCategorySchema,
}).strict();

const squadSnapshotSchema = z.object({
  id: z.string().min(1).max(128),
  agents: z.array(squadAgentSchema).min(1).max(128),
}).strict();

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const plannedTaskReceiptEntrySchema = plannedTaskRowSchema.extend({
  taskId: entityIdSchema,
}).strict();

const rosterSnapshotEnvelopeSchema = z.object({
  version: z.literal(1),
  agents: z.array(squadAgentSchema).min(1).max(128),
}).strict();

const planReceiptEnvelopeSchema = z.object({
  version: z.literal(1),
  missionId: entityIdSchema,
  intentVersion: z.number().int().nonnegative(),
  squadId: z.string().min(1).max(128),
  rosterHash: hashSchema,
  tasks: z.array(plannedTaskReceiptEntrySchema).min(1).max(64),
}).strict();

const taskPlanDatabaseRowSchema = z.object({
  mission_id: entityIdSchema,
  intent_version: z.number().int().nonnegative(),
  plan_hash: hashSchema,
  planner_json: z.string().min(1),
  squad_id: z.string().min(1).max(128).nullable(),
  roster_hash: hashSchema.nullable(),
  roster_snapshot_json: z.string().min(1).nullable(),
  created_at: z.number().int().nonnegative(),
}).strict();

export interface ApprovedPreflightTaskPlanAuthority {
  readonly kind: 'approved-preflight';
  readonly intentVersion: number;
  readonly approvedAt: number;
  readonly approvalReviewSha256?: string;
}

export interface AtomicTaskPlanInput {
  readonly missionId: string;
  readonly intentVersion: number;
  readonly squad: {
    readonly id: string;
    readonly agents: readonly SquadAgent[];
  };
  readonly rows: readonly z.infer<typeof plannedTaskRowSchema>[];
  /**
   * Trusted Main-only capability for the approval → sealed-plan preflight.
   * Ordinary MCP planning omits it and therefore still requires `running`.
   */
  readonly approvedPreflight?: ApprovedPreflightTaskPlanAuthority;
}

export interface TaskPlanReceiptEntry {
  readonly plannerId: string;
  readonly taskId: string;
  readonly title: string;
  readonly detail: string;
  readonly agentRef: string;
  readonly agentCategory: AgentCategory;
}

export type TaskPlanAgentSnapshot = Readonly<
  Omit<SquadAgent, 'allowedSkills' | 'allowedTools'> & {
    readonly allowedSkills?: readonly string[] | null;
    readonly allowedTools?: readonly string[] | null;
  }
>;

/**
 * Canonical authority for the agent roster embedded in a task-plan receipt.
 *
 * This hash intentionally covers the executable agent identities only. It is
 * distinct from `snapshotSquadAuthority(...).hash`, which also binds squad
 * metadata, instructions and runtime lineage at the mission-approval gate.
 */
export interface TaskPlanRosterSnapshot {
  readonly version: 1;
  readonly hash: string;
  readonly canonicalJson: string;
}

export interface TaskPlanReceipt {
  readonly version: 1;
  readonly missionId: string;
  readonly intentVersion: number;
  readonly planHash: string;
  readonly squadId: string;
  readonly rosterHash: string;
  readonly agents: readonly TaskPlanAgentSnapshot[];
  readonly tasks: readonly TaskPlanReceiptEntry[];
  readonly createdAt: number;
  readonly projectId: string;
  readonly checkoutId: string;
}

export interface PlannedTaskRecord {
  readonly plannerId: string;
  readonly taskId: string;
  readonly missionId: string;
  readonly intentVersion: number;
  readonly squadId: string;
  readonly rosterHash: string;
  readonly agentRef: string;
  readonly agentCategory: AgentCategory;
  readonly agent: TaskPlanAgentSnapshot;
  readonly plannedTitle: string;
  readonly plannedDetail: string;
  readonly task: ScopedTaskRecord;
}

interface SealedPlan {
  readonly rosterHash: string;
  readonly rosterJson: string;
  readonly planHash: string;
  readonly plannerJson: string;
  readonly entries: readonly z.infer<typeof plannedTaskReceiptEntrySchema>[];
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('task plan contains a non-finite number');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const entry = object[key];
      if (entry === undefined) continue;
      result[key] = canonicalize(entry);
    }
    return result;
  }
  throw new TypeError('task plan contains a non-JSON value');
}

function canonicalJson(value: unknown): string {
  const result = JSON.stringify(canonicalize(value));
  if (Buffer.byteLength(result, 'utf8') > 1_048_576) {
    throw new TypeError('task plan receipt exceeds 1 MiB');
  }
  return result;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function snapshotTaskPlanRoster(
  agents: readonly SquadAgent[],
): TaskPlanRosterSnapshot {
  validateRosterIdentity(agents);
  const envelope = rosterSnapshotEnvelopeSchema.parse({
    version: 1,
    agents,
  });
  const serialized = canonicalJson(envelope);
  return Object.freeze({
    version: 1,
    hash: sha256(serialized),
    canonicalJson: serialized,
  });
}

function freezeAgent(agent: SquadAgent): TaskPlanAgentSnapshot {
  return Object.freeze({
    ...agent,
    ...(agent.allowedSkills !== undefined
      ? {
          allowedSkills:
            agent.allowedSkills === null
              ? null
              : Object.freeze([...agent.allowedSkills]),
        }
      : {}),
    ...(agent.allowedTools !== undefined
      ? {
          allowedTools:
            agent.allowedTools === null
              ? null
              : Object.freeze([...agent.allowedTools]),
        }
      : {}),
  });
}

function validateRosterIdentity(agents: readonly SquadAgent[]): void {
  const references = new Map<string, Set<number>>();
  for (let index = 0; index < agents.length; index += 1) {
    const agent = agents[index]!;
    for (const reference of new Set([agent.id, agent.agentName])) {
      const owners = references.get(reference) ?? new Set<number>();
      owners.add(index);
      references.set(reference, owners);
    }
  }
  for (const [reference, owners] of references) {
    if (owners.size !== 1) {
      throw new Error(`ambiguous squad roster reference: ${reference}`);
    }
  }
}

function resolveRosterAgent(
  agents: readonly SquadAgent[],
  rawReference: string,
): SquadAgent {
  const matches = agents.filter(
    (agent) => agent.id === rawReference || agent.agentName === rawReference,
  );
  if (matches.length !== 1) {
    throw new Error(`task agent is not an unambiguous roster member: ${rawReference}`);
  }
  return matches[0]!;
}

function sealPlan(input: {
  readonly missionId: string;
  readonly intentVersion: number;
  readonly squadId: string;
  readonly agents: readonly SquadAgent[];
  readonly rows: readonly z.infer<typeof plannedTaskRowSchema>[];
}): SealedPlan {
  const roster = snapshotTaskPlanRoster(input.agents);
  const rosterJson = roster.canonicalJson;
  const rosterHash = roster.hash;
  const entries = input.rows.map((row) => {
    const agent = resolveRosterAgent(input.agents, row.agentRef);
    if (agent.category !== row.agentCategory) {
      throw new Error(
        `task agent category mismatch: ${agent.id} is ${agent.category}, not ${row.agentCategory}`,
      );
    }
    if (agent.category === 'orchestrator') {
      throw new Error(`task plan cannot assign worker task to orchestrator: ${agent.id}`);
    }
    return plannedTaskReceiptEntrySchema.parse({
      ...row,
      taskId: plannedTaskId(input.missionId, input.intentVersion, row.plannerId),
      agentRef: agent.id,
    });
  });
  const plannerEnvelope = planReceiptEnvelopeSchema.parse({
    version: 1,
    missionId: input.missionId,
    intentVersion: input.intentVersion,
    squadId: input.squadId,
    rosterHash,
    tasks: entries,
  });
  const plannerJson = canonicalJson(plannerEnvelope);
  return Object.freeze({
    rosterHash,
    rosterJson,
    planHash: sha256(plannerJson),
    plannerJson,
    entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
  });
}

export function plannedTaskId(
  missionId: string,
  intentVersion: number,
  plannerId: string,
): string {
  const digest = createHash('sha256')
    .update(`${missionId}\0${intentVersion}\0${plannerId}`)
    .digest('hex');
  return `task-${digest.slice(0, 48)}`;
}

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

  /**
   * Persist a complete planner wave all-or-nothing. Replaying the exact plan
   * returns the same deterministic task ids; a divergent replay for the same
   * mission intent is rejected instead of appending a second plan.
   */
  createPlanAtomically(rawInput: AtomicTaskPlanInput): ScopedTaskRecord[] {
    const missionId = entityIdSchema.parse(rawInput.missionId);
    const intentVersion = z.number().int().nonnegative().parse(rawInput.intentVersion);
    const squad = squadSnapshotSchema.parse(rawInput.squad);
    const rows = z.array(plannedTaskRowSchema).min(1).max(64).parse(rawInput.rows);
    const approvedPreflight = z
      .object({
        kind: z.literal('approved-preflight'),
        intentVersion: z.number().int().positive().max(1_000_000),
        approvedAt: z.number().int().positive(),
        approvalReviewSha256: hashSchema.optional(),
      })
      .strict()
      .optional()
      .parse(rawInput.approvedPreflight);
    if (new Set(rows.map((row) => row.plannerId)).size !== rows.length) {
      throw new Error('planner task ids must be unique');
    }
    const sealed = sealPlan({
      missionId,
      intentVersion,
      squadId: squad.id,
      agents: squad.agents,
      rows,
    });
    const now = this.#binding.now();
    const db = this.#binding.writeDatabase();
    let inserted = false;
    db.transaction(() => {
      const mission = db.prepare(
        `SELECT status, intent_state, intent_contract_json, intent_version,
                squad_id, orch_session_id
           FROM missions
          WHERE id = ?`,
      ).get(missionId) as {
        status: string;
        intent_state: string;
        intent_contract_json: string | null;
        intent_version: number;
        squad_id: string | null;
        orch_session_id: string | null;
      } | undefined;
      if (!mission) throw new Error(`mission not found: ${missionId}`);
      let exactApprovedPreflight = false;
      if (approvedPreflight) {
        const parsedContract = (() => {
          try {
            return missionIntentContractSchema.parse(
              JSON.parse(mission.intent_contract_json ?? 'null'),
            );
          } catch {
            return null;
          }
        })();
        exactApprovedPreflight = Boolean(
          parsedContract &&
            mission.status === 'pending' &&
            mission.intent_state === 'ready_to_start' &&
            mission.orch_session_id === null &&
            mission.intent_version === approvedPreflight.intentVersion &&
            parsedContract.intentVersion === approvedPreflight.intentVersion &&
            parsedContract.approvedAt === approvedPreflight.approvedAt &&
            parsedContract.approvalReviewSha256 ===
              approvedPreflight.approvalReviewSha256 &&
            parsedContract.dispatchedAt === undefined,
        );
      }
      if (mission.status !== 'running' && !exactApprovedPreflight) {
        throw new Error(
          'task plan requires running mission or exact main-owned approved preflight',
        );
      }
      if (mission.intent_version !== intentVersion) {
        throw new Error('task plan intentVersion is stale');
      }
      if (!mission.squad_id) {
        throw new Error('task plan requires mission bound to a squad roster');
      }
      if (mission.squad_id !== squad.id) {
        throw new Error(
          `task plan squad mismatch: mission=${mission.squad_id}, receipt=${squad.id}`,
        );
      }
      const existing = db.prepare(
        `SELECT plan_hash, roster_hash, squad_id FROM mission_task_plans
         WHERE mission_id = ? AND intent_version = ?`,
      ).get(missionId, intentVersion) as {
        plan_hash: string;
        roster_hash: string | null;
        squad_id: string | null;
      } | undefined;
      if (existing) {
        const receipt = this.#getPlanReceiptFromDatabase(
          db,
          missionId,
          intentVersion,
        );
        if (
          !receipt ||
          existing.plan_hash !== sealed.planHash ||
          existing.roster_hash !== sealed.rosterHash ||
          existing.squad_id !== squad.id
        ) {
          throw new Error('task plan conflict: this mission intent already has a different plan');
        }
        return;
      }
      db.prepare(
        `INSERT INTO mission_task_plans
           (mission_id, intent_version, plan_hash, planner_json, created_at,
            squad_id, roster_hash, roster_snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        missionId,
        intentVersion,
        sealed.planHash,
        sealed.plannerJson,
        now,
        squad.id,
        sealed.rosterHash,
        sealed.rosterJson,
      );
      const insert = db.prepare(
        `INSERT INTO tasks
           (id, mission_id, title, detail, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      );
      for (const entry of sealed.entries) {
        insert.run(
          entry.taskId,
          missionId,
          entry.title,
          entry.detail,
          now,
          now,
        );
      }
      inserted = true;
    }).immediate();
    const planned = this.#listPlannedTasksFromDatabase(
      db,
      missionId,
      intentVersion,
    );
    if (inserted) this.#binding.emitChange();
    return planned.map((record) => ({ ...record.task }));
  }

  hasPlan(rawMissionId: string, rawIntentVersion: number): boolean {
    const missionId = entityIdSchema.parse(rawMissionId);
    const intentVersion = z.number().int().nonnegative().parse(rawIntentVersion);
    const db = this.#binding.readDatabase();
    const exists = db.prepare(
      `SELECT 1 AS present FROM mission_task_plans
       WHERE mission_id = ? AND intent_version = ?`,
    ).get(missionId, intentVersion);
    if (exists === undefined) return false;
    return this.#getPlanReceiptFromDatabase(db, missionId, intentVersion) !== null;
  }

  getPlanReceipt(
    rawMissionId: string,
    rawIntentVersion: number,
  ): TaskPlanReceipt | null {
    const missionId = entityIdSchema.parse(rawMissionId);
    const intentVersion = z.number().int().nonnegative().parse(rawIntentVersion);
    return this.#getPlanReceiptFromDatabase(
      this.#binding.readDatabase(),
      missionId,
      intentVersion,
    );
  }

  getPlannedTask(rawTaskId: string): PlannedTaskRecord | null {
    const taskId = entityIdSchema.parse(rawTaskId);
    return this.#getPlannedTaskFromDatabase(
      this.#binding.readDatabase(),
      taskId,
    );
  }

  listPlannedTasks(
    rawMissionId: string,
    rawIntentVersion: number,
  ): PlannedTaskRecord[] {
    const missionId = entityIdSchema.parse(rawMissionId);
    const intentVersion = z.number().int().nonnegative().parse(rawIntentVersion);
    return this.#listPlannedTasksFromDatabase(
      this.#binding.readDatabase(),
      missionId,
      intentVersion,
    );
  }

  update(rawId: string, rawPatch: TaskPatch): ScopedTaskRecord | null {
    const id = entityIdSchema.parse(rawId);
    const patch = taskPatchSchema.parse(rawPatch);
    const db = this.#binding.writeDatabase();
    const updated = db.transaction(() => {
      const existing = this.#getFromDatabase(db, id);
      if (!existing) return null;
      if (this.#getPlannedTaskFromDatabase(db, id)) {
        throw new Error(
          'sealed planned task is immutable; TaskDispatchStore owns its lifecycle',
        );
      }
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

  #getPlanReceiptFromDatabase(
    db: Database.Database,
    missionId: string,
    intentVersion: number,
  ): TaskPlanReceipt | null {
    const rawRow = db.prepare(
      `SELECT mission_id, intent_version, plan_hash, planner_json, squad_id,
              roster_hash, roster_snapshot_json, created_at
       FROM mission_task_plans
       WHERE mission_id = ? AND intent_version = ?`,
    ).get(missionId, intentVersion);
    if (rawRow === undefined) return null;
    try {
      const row = taskPlanDatabaseRowSchema.parse(rawRow);
      if (!row.squad_id || !row.roster_hash || !row.roster_snapshot_json) {
        throw new Error('legacy plan has no sealed roster contract');
      }
      const rosterEnvelope = rosterSnapshotEnvelopeSchema.parse(
        JSON.parse(row.roster_snapshot_json),
      );
      const roster = snapshotTaskPlanRoster(rosterEnvelope.agents);
      if (roster.hash !== row.roster_hash) {
        throw new Error('roster hash mismatch');
      }
      const plannerEnvelope = planReceiptEnvelopeSchema.parse(
        JSON.parse(row.planner_json),
      );
      if (sha256(canonicalJson(plannerEnvelope)) !== row.plan_hash) {
        throw new Error('plan hash mismatch');
      }
      if (
        plannerEnvelope.missionId !== row.mission_id ||
        plannerEnvelope.intentVersion !== row.intent_version ||
        plannerEnvelope.squadId !== row.squad_id ||
        plannerEnvelope.rosterHash !== row.roster_hash
      ) {
        throw new Error('plan envelope does not match its database coordinates');
      }
      const plannerIds = new Set<string>();
      const taskIds = new Set<string>();
      for (const entry of plannerEnvelope.tasks) {
        if (plannerIds.has(entry.plannerId) || taskIds.has(entry.taskId)) {
          throw new Error('plan receipt contains duplicate task identity');
        }
        plannerIds.add(entry.plannerId);
        taskIds.add(entry.taskId);
        if (
          entry.taskId !==
          plannedTaskId(row.mission_id, row.intent_version, entry.plannerId)
        ) {
          throw new Error('planned task id is not deterministic');
        }
        const agent = resolveRosterAgent(rosterEnvelope.agents, entry.agentRef);
        if (agent.id !== entry.agentRef || agent.category !== entry.agentCategory) {
          throw new Error('planned task agent does not match roster snapshot');
        }
        const task = this.#getFromDatabase(db, entry.taskId);
        if (!task || task.missionId !== row.mission_id) {
          throw new Error('plan receipt points to a missing or foreign task');
        }
        if (task.title !== entry.title || task.detail !== entry.detail) {
          throw new Error('planned task row differs from its sealed receipt');
        }
      }
      return Object.freeze({
        version: 1,
        missionId: row.mission_id,
        intentVersion: row.intent_version,
        planHash: row.plan_hash,
        squadId: row.squad_id,
        rosterHash: row.roster_hash,
        agents: Object.freeze(
          rosterEnvelope.agents.map((agent) => freezeAgent(agent)),
        ),
        tasks: Object.freeze(
          plannerEnvelope.tasks.map((entry) => Object.freeze({ ...entry })),
        ),
        createdAt: row.created_at,
        ...this.#binding.coordinates,
      });
    } catch (error) {
      throw new ScopedStoreCorruptionError('task plan receipt', { cause: error });
    }
  }

  #listPlannedTasksFromDatabase(
    db: Database.Database,
    missionId: string,
    intentVersion: number,
  ): PlannedTaskRecord[] {
    const receipt = this.#getPlanReceiptFromDatabase(
      db,
      missionId,
      intentVersion,
    );
    if (!receipt) return [];
    const agents = new Map(receipt.agents.map((agent) => [agent.id, agent]));
    return receipt.tasks.map((entry) => {
      const task = this.#getFromDatabase(db, entry.taskId);
      const agent = agents.get(entry.agentRef);
      if (!task || !agent) {
        throw new ScopedStoreCorruptionError('task plan receipt');
      }
      return Object.freeze({
        plannerId: entry.plannerId,
        taskId: entry.taskId,
        missionId: receipt.missionId,
        intentVersion: receipt.intentVersion,
        squadId: receipt.squadId,
        rosterHash: receipt.rosterHash,
        agentRef: entry.agentRef,
        agentCategory: entry.agentCategory,
        agent,
        plannedTitle: entry.title,
        plannedDetail: entry.detail,
        task: Object.freeze({ ...task }),
      });
    });
  }

  #getPlannedTaskFromDatabase(
    db: Database.Database,
    taskId: string,
  ): PlannedTaskRecord | null {
    const task = this.#getFromDatabase(db, taskId);
    if (!task?.missionId) return null;
    const planVersions = db.prepare(
      `SELECT intent_version FROM mission_task_plans
       WHERE mission_id = ? ORDER BY intent_version DESC`,
    ).all(task.missionId) as Array<{ intent_version: number }>;
    for (const row of planVersions) {
      const planned = this.#listPlannedTasksFromDatabase(
        db,
        task.missionId,
        row.intent_version,
      ).find((candidate) => candidate.taskId === taskId);
      if (planned) return planned;
    }
    return null;
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
