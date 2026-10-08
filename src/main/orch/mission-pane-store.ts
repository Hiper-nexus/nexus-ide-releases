import { z } from 'zod';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  MissionPaneAuthoritySeal,
  MissionPaneSpec,
  VisualTaskRequirement,
} from '../../shared/orch-types';
import { isAutomatedReviewerPaneIdentity } from '../../shared/automated-reviewer-pane';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
  type ScopedStoreChangeListener,
  type ScopedStoreOptions,
} from './scoped-store';
import { sameMissionPaneComposition } from './mission-pane-identity';

const capabilityListSchema = z.array(z.string().min(1).max(128)).max(256);
const nullableCapabilityListSchema = capabilityListSchema.nullable();
const entityIdSchema = z.string().min(1).max(256);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const legacyVisualTaskSchema = z.object({ since: z.number().int().nonnegative().safe() }).strict();
const visualTaskSchema = legacyVisualTaskSchema.extend({ id: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/) });
const missionPaneAuthoritySealSchema = z
  .object({
    intentVersion: z.number().int().positive().max(1_000_000),
    intentContractHash: hashSchema,
    contextRevision: z.string().min(1).max(256),
    contractHash: hashSchema,
    squadRevisionHash: hashSchema,
  })
  .strict();

const recordMissionPaneInputSchema = z
  .object({
    missionId: entityIdSchema,
    adapterId: z.string().min(1).max(64),
    model: z.string().min(1).max(128).optional(),
    accountId: z.string().min(1).max(128).optional(),
    effort: z.string().min(1).max(64).optional(),
    cwd: z.string().min(1).max(4_096).optional(),
    title: z.string().min(1).max(512).optional(),
    agentName: z.string().min(1).max(256).optional(),
    workerIncarnationId: entityIdSchema.optional(),
    role: z.enum(['orchestrator', 'worker']).optional(),
    allowedTools: nullableCapabilityListSchema.optional(),
    allowedSkills: nullableCapabilityListSchema.optional(),
    readOnly: z.boolean().optional(),
    paneId: entityIdSchema.optional(),
    executionScope: projectExecutionScopeSchema.optional(),
    authoritySeal: missionPaneAuthoritySealSchema.optional(),
    operatorOpened: z.boolean().optional(),
    visualTask: visualTaskSchema.optional(),
  })
  .strict();

const rebindOrchestratorAuthorityInputSchema = z
  .object({
    missionId: entityIdSchema,
    paneId: entityIdSchema,
    expectedAuthoritySeal: missionPaneAuthoritySealSchema,
    authoritySeal: missionPaneAuthoritySealSchema,
  })
  .strict();

const missionPaneRowSchema = z
  .object({
    id: entityIdSchema,
    mission_id: entityIdSchema,
    adapter_id: z.string().min(1).max(64),
    model: z.string().min(1).max(128).nullable(),
    account_id: z.string().min(1).max(128).nullable(),
    effort: z.string().min(1).max(64).nullable(),
    cwd: z.string().min(1).max(4_096).nullable(),
    title: z.string().min(1).max(512),
    agent_name: z.string().min(1).max(256).nullable(),
    role: z.enum(['orchestrator', 'worker']),
    pane_id: entityIdSchema.nullable(),
    scope_json: z.string().min(1),
    allowed_tools_json: z.string().nullable(),
    allowed_skills_json: z.string().nullable(),
    operator_opened: z.number().int().min(0).max(1).nullable(),
    created_at: z.number().int().nonnegative(),
  })
  .strict();

export type RecordMissionPaneInput = z.input<
  typeof recordMissionPaneInputSchema
>;
export type RebindOrchestratorAuthorityInput = z.input<
  typeof rebindOrchestratorAuthorityInputSchema
>;

export interface ScopedMissionPaneSpec extends MissionPaneSpec {
  scope: ProjectExecutionScope;
  executionScope: ProjectExecutionScope;
}

/**
 * Strict legacy signature for PREVC reviewers that were accidentally stored
 * as durable mission composition. Ordinary reviewers keep a worker
 * incarnation and/or the handoff contract, so they remain reopenable.
 */
export function isAutomatedReviewerCompositionPane(
  pane: Pick<
    MissionPaneSpec,
    | 'missionId'
    | 'adapterId'
    | 'title'
    | 'agentName'
    | 'role'
    | 'readOnly'
    | 'workerIncarnationId'
    | 'paneId'
    | 'allowedTools'
  >,
): boolean {
  return (
    isAutomatedReviewerPaneIdentity(pane) &&
    pane.readOnly === true &&
    pane.workerIncarnationId === undefined &&
    typeof pane.paneId === 'string' &&
    Array.isArray(pane.allowedTools) &&
    pane.allowedTools.includes('nexus_merge_review_submit') &&
    !pane.allowedTools.includes('nexus_handoff_submit')
  );
}

const persistedPaneScopesV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    coordinationScope: projectExecutionScopeSchema,
    executionScope: projectExecutionScopeSchema,
  })
  .strict();
const persistedPaneScopesV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    coordinationScope: projectExecutionScopeSchema,
    executionScope: projectExecutionScopeSchema,
    readOnly: z.boolean(),
  })
  .strict();
const persistedPaneScopesV4Schema = z
  .object({
    schemaVersion: z.literal(4),
    coordinationScope: projectExecutionScopeSchema,
    executionScope: projectExecutionScopeSchema,
    readOnly: z.boolean(),
    workerIncarnationId: entityIdSchema.nullable(),
  })
  .strict();
const persistedPaneScopesV5Schema = z
  .object({
    schemaVersion: z.literal(5),
    coordinationScope: projectExecutionScopeSchema,
    executionScope: projectExecutionScopeSchema,
    readOnly: z.boolean(),
    workerIncarnationId: entityIdSchema.nullable(),
    authoritySeal: missionPaneAuthoritySealSchema.nullable(),
  })
  .strict();
const persistedPaneScopesV6Schema = persistedPaneScopesV5Schema.extend({
  schemaVersion: z.literal(6), visualTask: legacyVisualTaskSchema.nullable(),
});
const persistedPaneScopesV7Schema = persistedPaneScopesV5Schema.extend({
  schemaVersion: z.literal(7), visualTask: visualTaskSchema.nullable(),
});
const persistedPaneScopesSchema = z.union([
  persistedPaneScopesV2Schema,
  persistedPaneScopesV3Schema,
  persistedPaneScopesV4Schema,
  persistedPaneScopesV5Schema,
  persistedPaneScopesV6Schema,
  persistedPaneScopesV7Schema,
]);

function encodeCapabilityList(
  value: string[] | null | undefined,
): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value === null ? null : capabilityListSchema.parse(value));
}

function parseCapabilityList(
  raw: string | null,
  label: string,
): string[] | null | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null) return null;
    return [...capabilityListSchema.parse(value)];
  } catch (error) {
    throw new ScopedStoreCorruptionError(label, { cause: error });
  }
}

function cloneSpec(spec: ScopedMissionPaneSpec): ScopedMissionPaneSpec {
  return {
    ...spec,
    visualTask: spec.visualTask ? Object.freeze({ ...spec.visualTask }) : undefined,
    allowedTools:
      spec.allowedTools === null
        ? null
        : spec.allowedTools === undefined
          ? undefined
          : [...spec.allowedTools],
    allowedSkills:
      spec.allowedSkills === null
        ? null
        : spec.allowedSkills === undefined
          ? undefined
          : [...spec.allowedSkills],
    scope: Object.freeze({ ...spec.scope }),
    executionScope: Object.freeze({ ...spec.executionScope }),
    authoritySeal: spec.authoritySeal
      ? Object.freeze({ ...spec.authoritySeal })
      : undefined,
  };
}

function sameAuthoritySeal(
  left: MissionPaneAuthoritySeal,
  right: MissionPaneAuthoritySeal,
): boolean {
  return (
    left.intentVersion === right.intentVersion &&
    left.intentContractHash === right.intentContractHash &&
    left.contextRevision === right.contextRevision &&
    left.contractHash === right.contractHash &&
    left.squadRevisionHash === right.squadRevisionHash
  );
}

function sameApprovalSeal(
  left: MissionPaneAuthoritySeal,
  right: MissionPaneAuthoritySeal,
): boolean {
  return (
    left.intentVersion === right.intentVersion &&
    left.intentContractHash === right.intentContractHash &&
    left.squadRevisionHash === right.squadRevisionHash
  );
}

function encodePersistedPaneScopes(input: {
  readonly coordinationScope: ProjectExecutionScope;
  readonly executionScope: ProjectExecutionScope;
  readonly readOnly: boolean;
  readonly workerIncarnationId?: string;
  readonly authoritySeal?: MissionPaneAuthoritySeal;
  readonly visualTask?: VisualTaskRequirement;
}): string {
  return JSON.stringify({
    schemaVersion: 7,
    visualTask: input.visualTask ?? null,
    coordinationScope: input.coordinationScope,
    executionScope: input.executionScope,
    readOnly: input.readOnly,
    workerIncarnationId: input.workerIncarnationId ?? null,
    authoritySeal: input.authoritySeal ?? null,
  });
}

export class ScopedMissionPaneStore {
  readonly #binding: ScopedStoreBinding;

  constructor(
    runtimeManager: ProjectRuntimeManager,
    scope: ProjectExecutionScope,
    options: ScopedStoreOptions = {},
  ) {
    this.#binding = new ScopedStoreBinding(runtimeManager, scope, options);
    const removed = this.#garbageCollectLegacyAutomatedReviewers();
    if (removed > 0) {
      console.info(
        `[orch] removed ${removed} transient PREVC reviewer pane(s) from durable composition`,
      );
    }
  }

  get scope(): ProjectExecutionScope {
    return this.#binding.scope;
  }

  onChange(listener: ScopedStoreChangeListener): () => void {
    return this.#binding.onChange(listener);
  }

  /**
   * Records one composition member. Identity is adapter/model/account/cwd/
   * title/role; later calls may only fill authority fields that were absent.
   */
  record(rawInput: RecordMissionPaneInput): ScopedMissionPaneSpec {
    const input = recordMissionPaneInputSchema.parse(rawInput);
    if (
      input.executionScope &&
      (input.executionScope.installationId !== this.#binding.scope.installationId ||
        input.executionScope.projectId !== this.#binding.scope.projectId ||
        input.executionScope.checkoutId !== this.#binding.scope.checkoutId)
    ) {
      throw new Error('mission pane execution scope differs from project scope');
    }
    const title = input.title ?? input.agentName ?? input.adapterId;
    const role = input.role ?? 'worker';
    if (input.workerIncarnationId && role !== 'worker') {
      throw new Error('worker incarnation may only bind a worker mission pane');
    }
    const db = this.#binding.writeDatabase();
    const result = db.transaction(() => {
      const existing = this.#listFromDatabase(db, input.missionId).find(
        (spec) =>
          sameMissionPaneComposition(spec, {
            adapterId: input.adapterId,
            model: input.model,
            accountId: input.accountId,
            cwd: input.cwd,
            title,
            role,
            workerIncarnationId: input.workerIncarnationId,
          }),
      );
      if (input.paneId !== undefined) {
        const owners = this.#findRowsByPaneId(db, input.paneId);
        if (owners.length > 1) {
          throw new ScopedStoreCorruptionError('mission pane ownership');
        }
        if (owners.length === 1 && owners[0].id !== existing?.id) {
          // Missão encerrada (done/failed) solta o pane: o orquestrador que a
          // criou volta a ser a mão do operador e pode abrir outra missão. A
          // linha antiga fica no histórico, só sem o vínculo com o pane vivo.
          const owner = db
            .prepare('SELECT status FROM missions WHERE id = ?')
            .get(owners[0].missionId) as { status?: string } | undefined;
          if (
            owners[0].missionId === input.missionId ||
            (owner?.status !== 'done' && owner?.status !== 'failed')
          ) {
            throw new Error('pane id already belongs to another mission pane');
          }
          db.prepare('UPDATE mission_panes SET pane_id = NULL WHERE id = ?').run(owners[0].id);
        }
      }
      if (existing) return this.#fillMissingAuthority(db, existing, input);

      const spec: ScopedMissionPaneSpec = {
        id: this.#binding.makeId('mpane'),
        missionId: input.missionId,
        adapterId: input.adapterId,
        model: input.model,
        accountId: input.accountId,
        effort: input.effort,
        cwd: input.cwd,
        title,
        agentName: input.agentName,
        workerIncarnationId: input.workerIncarnationId,
        visualTask: input.visualTask ? Object.freeze({ ...input.visualTask }) : undefined,
        role,
        operatorOpened: input.operatorOpened === true || undefined,
        paneId: input.paneId,
        allowedTools:
          input.allowedTools === null
            ? null
            : input.allowedTools === undefined
              ? undefined
              : [...input.allowedTools],
        allowedSkills:
          input.allowedSkills === null
            ? null
            : input.allowedSkills === undefined
              ? undefined
              : [...input.allowedSkills],
        readOnly: input.readOnly === true,
        authoritySeal: input.authoritySeal
          ? Object.freeze({ ...input.authoritySeal })
          : undefined,
        scope: this.#binding.scope,
        executionScope: input.executionScope ?? this.#binding.scope,
        createdAt: this.#binding.now(),
      };
      db.prepare(
        `INSERT INTO mission_panes
           (id, mission_id, adapter_id, model, account_id, effort, cwd, title,
            agent_name, role, pane_id, scope_json, allowed_tools_json,
            allowed_skills_json, operator_opened, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        spec.id,
        spec.missionId,
        spec.adapterId,
        spec.model ?? null,
        spec.accountId ?? null,
        spec.effort ?? null,
        spec.cwd ?? null,
        spec.title,
        spec.agentName ?? null,
        spec.role,
        spec.paneId ?? null,
        encodePersistedPaneScopes({
          coordinationScope: this.#binding.scope,
          executionScope: spec.executionScope,
          readOnly: spec.readOnly === true,
          workerIncarnationId: spec.workerIncarnationId,
          authoritySeal: spec.authoritySeal,
          visualTask: spec.visualTask,
        }),
        encodeCapabilityList(spec.allowedTools),
        encodeCapabilityList(spec.allowedSkills),
        spec.operatorOpened === true ? 1 : 0,
        spec.createdAt,
      );
      return { spec, changed: true };
    })();
    if (result.changed) this.#binding.emitChange();
    return cloneSpec(result.spec);
  }

  list(rawMissionId: string): ScopedMissionPaneSpec[] {
    const missionId = entityIdSchema.parse(rawMissionId);
    return this.#listFromDatabase(this.#binding.readDatabase(), missionId);
  }

  promotePaneToOrchestrator(
    rawMissionId: string,
    rawPaneId: string,
  ): ScopedMissionPaneSpec | null {
    const missionId = entityIdSchema.parse(rawMissionId);
    const paneId = entityIdSchema.parse(rawPaneId);
    const db = this.#binding.writeDatabase();
    const result = db.transaction(() => {
      const rows = this.#listFromDatabase(db, missionId);
      const target = rows.find((spec) => spec.paneId === paneId);
      if (!target) return { spec: null, changed: false };

      const update = db.prepare(
        `UPDATE mission_panes
         SET role = ?, scope_json = ?, allowed_tools_json = ?,
             allowed_skills_json = ?
         WHERE id = ?`,
      );
      let changed = false;
      let promoted: ScopedMissionPaneSpec | null = null;
      for (const spec of rows) {
        const isPromoted = spec.id === target.id;
        const isPreviousLeader = !isPromoted && spec.role === 'orchestrator';
        const next: ScopedMissionPaneSpec = isPromoted
          ? {
              ...spec,
              role: 'orchestrator',
              workerIncarnationId: undefined,
              allowedTools: null,
              allowedSkills: null,
            }
          : isPreviousLeader
            ? {
                ...spec,
                role: 'worker',
                workerIncarnationId: undefined,
                allowedTools: [],
                allowedSkills: null,
              }
            : spec;
        if (isPromoted) promoted = next;
        if (next === spec) continue;
        const updateResult = update.run(
          next.role,
          encodePersistedPaneScopes({
            coordinationScope: this.#binding.scope,
            executionScope: next.executionScope,
            readOnly: next.readOnly === true,
            workerIncarnationId: next.workerIncarnationId,
            authoritySeal: next.authoritySeal,
            visualTask: next.visualTask,
          }),
          encodeCapabilityList(next.allowedTools),
          encodeCapabilityList(next.allowedSkills),
          next.id,
        );
        if (updateResult.changes !== 1) {
          throw new ScopedStoreCorruptionError('mission pane promotion');
        }
        changed = true;
      }
      return { spec: promoted, changed };
    })();
    if (result.changed) this.#binding.emitChange();
    return result.spec ? cloneSpec(result.spec) : null;
  }

  /** Compensation hook for a pane whose cross-store authority bind failed. */
  remove(rawId: string): boolean {
    const id = entityIdSchema.parse(rawId);
    const result = this.#binding
      .writeDatabase()
      .prepare('DELETE FROM mission_panes WHERE id = ?')
      .run(id);
    if (result.changes === 0) return false;
    this.#binding.emitChange();
    return true;
  }

  /** Duplicate pane ids are corruption/ambiguity and therefore return null. */
  findByPaneId(rawPaneId: string): ScopedMissionPaneSpec | null {
    const paneId = entityIdSchema.parse(rawPaneId);
    const rows = this.#findRowsByPaneId(this.#binding.readDatabase(), paneId);
    return rows.length === 1 ? rows[0] : null;
  }

  /**
   * F-664: a retomada da missão da aba continua a conversa num pane NOVO.
   * Quando o record() deduplica o pane novo na mesma linha (mesma identidade),
   * a linha passa a apontar para ele — senão cada "Retomar" voltava ao pane
   * antigo e à conversa de antes. Só orquestrador; pane já vinculado a outra
   * linha é recusado.
   */
  moveOrchestratorPane(
    rawMissionId: string,
    rawSpecId: string,
    rawPaneId: string,
  ): ScopedMissionPaneSpec {
    const missionId = entityIdSchema.parse(rawMissionId);
    const specId = entityIdSchema.parse(rawSpecId);
    const paneId = entityIdSchema.parse(rawPaneId);
    const db = this.#binding.writeDatabase();
    const result = db.transaction(() => {
      const spec = this.#listFromDatabase(db, missionId).find((row) => row.id === specId);
      if (!spec || spec.role !== 'orchestrator') {
        throw new Error('only a mission orchestrator pane may move');
      }
      if (spec.paneId === paneId) return { spec, changed: false };
      if (this.#findRowsByPaneId(db, paneId).length > 0) {
        throw new Error('pane id already belongs to a mission pane');
      }
      const update = db
        .prepare('UPDATE mission_panes SET pane_id = ? WHERE id = ?')
        .run(paneId, specId);
      if (update.changes !== 1) {
        throw new ScopedStoreCorruptionError('mission orchestrator pane move');
      }
      return { spec: { ...spec, paneId }, changed: true };
    })();
    if (result.changed) this.#binding.emitChange();
    return cloneSpec(result.spec);
  }

  /**
   * F-969: o failover de conta do Main troca a conta SELADA do orquestrador
   * antes de pedir o religamento do pane (a cerca do spawn persistido exige
   * `accountId` igual ao da linha). Compare-and-swap estreito: só a linha
   * exata (missão + pane + orquestrador) na conta esperada; o resto da
   * autoridade (selo, papel, escopo, ferramentas) fica intacto.
   */
  rebindPaneAccount(
    rawMissionId: string,
    rawPaneId: string,
    rawExpectedAccountId: string | null,
    rawAccountId: string,
  ): ScopedMissionPaneSpec | null {
    const missionId = entityIdSchema.parse(rawMissionId);
    const paneId = entityIdSchema.parse(rawPaneId);
    const accountId = z.string().min(1).max(128).parse(rawAccountId);
    const expected =
      rawExpectedAccountId === null
        ? null
        : z.string().min(1).max(128).parse(rawExpectedAccountId);
    const db = this.#binding.writeDatabase();
    const result = db.transaction(() => {
      const rows = this.#findRowsByPaneId(db, paneId);
      if (rows.length !== 1) return { spec: null, changed: false };
      const existing = rows[0];
      if (existing.missionId !== missionId || existing.role !== 'orchestrator') {
        return { spec: null, changed: false };
      }
      if (existing.accountId === accountId) {
        return { spec: cloneSpec(existing), changed: false };
      }
      if ((existing.accountId ?? null) !== expected) {
        return { spec: null, changed: false };
      }
      const update = db
        .prepare('UPDATE mission_panes SET account_id = ? WHERE id = ?')
        .run(accountId, existing.id);
      if (update.changes !== 1) {
        throw new ScopedStoreCorruptionError('mission orchestrator account rebind');
      }
      return { spec: cloneSpec({ ...existing, accountId }), changed: true };
    })();
    if (result.changed) this.#binding.emitChange();
    return result.spec ? cloneSpec(result.spec) : null;
  }

  /**
   * F-1002: linha do "+ Pane → Nesta missão" gravada antes da correção, sem a
   * conta/esforço que o Main selou no PTY. Preenche SÓ o campo ausente, a
   * partir da ficha física do Main (nunca do renderer), na linha exata
   * (missão + pane + worker do operador + encarnação). Valor já gravado nunca
   * é sobrescrito; divergência devolve null.
   */
  fillOperatorPaneSealedRuntime(input: {
    readonly missionId: string;
    readonly paneId: string;
    readonly workerIncarnationId: string | undefined;
    readonly accountId: string | undefined;
    readonly effort: string | undefined;
  }): ScopedMissionPaneSpec | null {
    const missionId = entityIdSchema.parse(input.missionId);
    const paneId = entityIdSchema.parse(input.paneId);
    const db = this.#binding.writeDatabase();
    const result = db.transaction(() => {
      const rows = this.#findRowsByPaneId(db, paneId);
      if (rows.length !== 1) return { spec: null, changed: false };
      const existing = rows[0];
      if (
        existing.missionId !== missionId ||
        existing.role !== 'worker' ||
        existing.operatorOpened !== true ||
        existing.workerIncarnationId !== input.workerIncarnationId
      ) {
        return { spec: null, changed: false };
      }
      const conflicts =
        (existing.accountId !== undefined &&
          existing.accountId !== input.accountId) ||
        (existing.effort !== undefined && existing.effort !== input.effort);
      if (conflicts) return { spec: null, changed: false };
      const next = {
        ...existing,
        accountId: existing.accountId ?? input.accountId,
        effort: existing.effort ?? input.effort,
      };
      if (
        next.accountId === existing.accountId &&
        next.effort === existing.effort
      ) {
        return { spec: existing, changed: false };
      }
      const update = db
        .prepare('UPDATE mission_panes SET account_id = ?, effort = ? WHERE id = ?')
        .run(next.accountId ?? null, next.effort ?? null, existing.id);
      if (update.changes !== 1) {
        throw new ScopedStoreCorruptionError('operator pane sealed runtime fill');
      }
      return { spec: next, changed: true };
    })();
    if (result.changed) this.#binding.emitChange();
    return result.spec ? cloneSpec(result.spec) : null;
  }

  /**
   * Explicit workflow-authority rotation for the current orchestrator pane.
   * This is a compare-and-swap: legacy/unsealed rows, workers, intent drift,
   * squad drift and a stale caller all fail closed. Workers deliberately keep
   * their old seal so freeze/refreeze revokes their prior generation.
   */
  rebindOrchestratorAuthority(
    rawInput: RebindOrchestratorAuthorityInput,
  ): ScopedMissionPaneSpec {
    const input = rebindOrchestratorAuthorityInputSchema.parse(rawInput);
    const db = this.#binding.writeDatabase();
    const result = db.transaction(() => {
      const rows = this.#findRowsByPaneId(db, input.paneId);
      if (rows.length !== 1) {
        throw new Error('mission orchestrator pane identity is unavailable');
      }
      const existing = rows[0];
      if (
        existing.missionId !== input.missionId ||
        existing.role !== 'orchestrator'
      ) {
        throw new Error('only the exact mission orchestrator may be resealed');
      }
      if (
        !existing.authoritySeal ||
        !sameAuthoritySeal(
          existing.authoritySeal,
          input.expectedAuthoritySeal,
        )
      ) {
        throw new Error('mission orchestrator authority changed before reseal');
      }
      if (
        !sameApprovalSeal(existing.authoritySeal, input.authoritySeal)
      ) {
        throw new Error(
          'mission orchestrator approval changed; replan and approve instead',
        );
      }
      if (sameAuthoritySeal(existing.authoritySeal, input.authoritySeal)) {
        return { spec: cloneSpec(existing), changed: false };
      }
      const updated: ScopedMissionPaneSpec = {
        ...existing,
        authoritySeal: Object.freeze({ ...input.authoritySeal }),
      };
      const update = db
        .prepare(
          `UPDATE mission_panes
           SET scope_json = ?
           WHERE id = ?`,
        )
        .run(
          encodePersistedPaneScopes({
            coordinationScope: this.#binding.scope,
            executionScope: updated.executionScope,
            readOnly: updated.readOnly === true,
            workerIncarnationId: updated.workerIncarnationId,
            authoritySeal: updated.authoritySeal,
            visualTask: updated.visualTask,
          }),
          updated.id,
        );
      if (update.changes !== 1) {
        throw new ScopedStoreCorruptionError(
          'mission orchestrator authority reseal',
        );
      }
      return { spec: cloneSpec(updated), changed: true };
    })();
    if (result.changed) this.#binding.emitChange();
    return cloneSpec(result.spec);
  }

  /** Main-only assignment update for an idle worker reused by the same mission. */
  assignVisualTask(paneId: string, missionId: string, workerIncarnationId: string | undefined,
    expected: VisualTaskRequirement | undefined, next: VisualTaskRequirement | undefined): boolean {
    if (next) visualTaskSchema.parse(next);
    const db = this.#binding.writeDatabase();
    const changed = db.transaction(() => {
      const rows = this.#findRowsByPaneId(db, entityIdSchema.parse(paneId));
      if (rows.length !== 1) return false;
      const existing = rows[0];
      if (existing.role !== 'worker' || existing.missionId !== missionId ||
          existing.workerIncarnationId !== workerIncarnationId || existing.visualTask?.since !== expected?.since ||
          existing.visualTask?.id !== expected?.id) return false;
      return db.prepare('UPDATE mission_panes SET scope_json = ? WHERE id = ?').run(encodePersistedPaneScopes({
        coordinationScope: this.#binding.scope, executionScope: existing.executionScope,
        readOnly: existing.readOnly === true, workerIncarnationId: existing.workerIncarnationId,
        authoritySeal: existing.authoritySeal, visualTask: next,
      }), existing.id).changes === 1;
    })();
    if (changed) this.#binding.emitChange();
    return changed;
  }

  #fillMissingAuthority(
    db: Database.Database,
    existing: ScopedMissionPaneSpec,
    input: RecordMissionPaneInput,
  ): { spec: ScopedMissionPaneSpec; changed: boolean } {
    if (
      input.executionScope &&
      input.executionScope.rootRealPath !== existing.executionScope.rootRealPath
    ) {
      throw new Error('mission pane execution scope is immutable');
    }
    if (
      input.readOnly !== undefined &&
      input.readOnly !== (existing.readOnly === true)
    ) {
      throw new Error('mission pane read-only authority is immutable');
    }
    if (
      existing.authoritySeal &&
      input.authoritySeal &&
      JSON.stringify(existing.authoritySeal) !==
        JSON.stringify(input.authoritySeal)
    ) {
      throw new Error('mission pane authority revision is immutable');
    }
    const paneId = existing.paneId ?? input.paneId;
    const allowedTools =
      existing.allowedTools === undefined
        ? input.allowedTools
        : existing.allowedTools;
    const allowedSkills =
      existing.allowedSkills === undefined
        ? input.allowedSkills
        : existing.allowedSkills;
    const authoritySeal = existing.authoritySeal ?? input.authoritySeal;
    const visualTask = existing.visualTask ?? input.visualTask;
    const hasChanges =
      paneId !== existing.paneId ||
      allowedTools !== existing.allowedTools ||
      allowedSkills !== existing.allowedSkills ||
      authoritySeal !== existing.authoritySeal || visualTask !== existing.visualTask;
    if (!hasChanges) return { spec: cloneSpec(existing), changed: false };

    const updated: ScopedMissionPaneSpec = {
      ...existing,
      visualTask,
      paneId,
      allowedTools:
        allowedTools === null
          ? null
          : allowedTools === undefined
            ? undefined
            : [...allowedTools],
      allowedSkills:
        allowedSkills === null
          ? null
          : allowedSkills === undefined
            ? undefined
            : [...allowedSkills],
      authoritySeal: authoritySeal
        ? Object.freeze({ ...authoritySeal })
        : undefined,
    };
    const result = db
      .prepare(
        `UPDATE mission_panes
         SET pane_id = ?, scope_json = ?, allowed_tools_json = ?,
             allowed_skills_json = ?
         WHERE id = ?`,
      )
      .run(
        updated.paneId ?? null,
        encodePersistedPaneScopes({
          coordinationScope: this.#binding.scope,
          executionScope: updated.executionScope,
          readOnly: updated.readOnly === true,
          workerIncarnationId: updated.workerIncarnationId,
          authoritySeal: updated.authoritySeal,
          visualTask: updated.visualTask,
        }),
        encodeCapabilityList(updated.allowedTools),
        encodeCapabilityList(updated.allowedSkills),
        updated.id,
      );
    if (result.changes !== 1) {
      throw new ScopedStoreCorruptionError('mission pane update');
    }
    return { spec: cloneSpec(updated), changed: true };
  }

  #listFromDatabase(
    db: Database.Database,
    missionId: string,
  ): ScopedMissionPaneSpec[] {
    const rows = db
      .prepare(
        `SELECT id, mission_id, adapter_id, model, account_id, effort, cwd,
                title, agent_name, role, pane_id, scope_json,
                allowed_tools_json, allowed_skills_json, operator_opened,
                created_at
         FROM mission_panes
         WHERE mission_id = ?
         ORDER BY CASE role WHEN 'orchestrator' THEN 0 ELSE 1 END,
                  created_at ASC, id ASC`,
      )
      .all(missionId);
    return rows.map((row) => this.#fromRow(row));
  }

  #garbageCollectLegacyAutomatedReviewers(): number {
    const db = this.#binding.writeDatabase();
    return db.transaction(() => {
      const rows = db
        .prepare(
          `SELECT id, mission_id, adapter_id, model, account_id, effort, cwd,
                  title, agent_name, role, pane_id, scope_json,
                  allowed_tools_json, allowed_skills_json, operator_opened,
                created_at
           FROM mission_panes
           WHERE role = 'worker'
             AND title LIKE 'review-%'
             AND agent_name LIKE 'reviewer-%'
           ORDER BY created_at ASC, id ASC`,
        )
        .all();
      const remove = db.prepare('DELETE FROM mission_panes WHERE id = ?');
      let removed = 0;
      for (const row of rows) {
        const pane = this.#fromRow(row);
        if (!isAutomatedReviewerCompositionPane(pane)) continue;
        removed += remove.run(pane.id).changes;
      }
      return removed;
    })();
  }

  #findRowsByPaneId(
    db: Database.Database,
    paneId: string,
  ): ScopedMissionPaneSpec[] {
    const rows = db
      .prepare(
        `SELECT id, mission_id, adapter_id, model, account_id, effort, cwd,
                title, agent_name, role, pane_id, scope_json,
                allowed_tools_json, allowed_skills_json, operator_opened,
                created_at
         FROM mission_panes WHERE pane_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT 2`,
      )
      .all(paneId);
    return rows.map((row) => this.#fromRow(row));
  }

  #fromRow(rawRow: unknown): ScopedMissionPaneSpec {
    let row: z.infer<typeof missionPaneRowSchema>;
    try {
      row = missionPaneRowSchema.parse(rawRow);
    } catch (error) {
      throw new ScopedStoreCorruptionError('mission pane', { cause: error });
    }

    let persistedScope: ProjectExecutionScope;
    let executionScope: ProjectExecutionScope;
    let readOnly = false;
    let workerIncarnationId: string | undefined;
    let authoritySeal: MissionPaneAuthoritySeal | undefined;
    let visualTask: VisualTaskRequirement | undefined;
    try {
      const raw = JSON.parse(row.scope_json) as unknown;
      const modern = persistedPaneScopesSchema.safeParse(raw);
      if (modern.success) {
        persistedScope = modern.data.coordinationScope;
        visualTask = modern.data.schemaVersion === 7 ? modern.data.visualTask ?? undefined :
          modern.data.schemaVersion === 6 && modern.data.visualTask ? { ...modern.data.visualTask,
            id: `legacy-${createHash('sha256').update(row.id).digest('hex')}` } : undefined;
        executionScope = modern.data.executionScope;
        readOnly =
          modern.data.schemaVersion === 3 ||
          modern.data.schemaVersion === 4 ||
          modern.data.schemaVersion === 5 || modern.data.schemaVersion === 6 || modern.data.schemaVersion === 7
            ? modern.data.readOnly === true
            : false;
        workerIncarnationId =
          modern.data.schemaVersion === 4 ||
          modern.data.schemaVersion === 5 || modern.data.schemaVersion === 6 || modern.data.schemaVersion === 7
            ? modern.data.workerIncarnationId ?? undefined
            : undefined;
        authoritySeal =
          modern.data.schemaVersion === 5 || modern.data.schemaVersion === 6 || modern.data.schemaVersion === 7
            ? modern.data.authoritySeal ?? undefined
            : undefined;
      } else {
        persistedScope = projectExecutionScopeSchema.parse(raw);
        executionScope = persistedScope;
      }
    } catch (error) {
      throw new ScopedStoreCorruptionError('mission pane scope', {
        cause: error,
      });
    }
    if (
      persistedScope.projectId !== this.#binding.scope.projectId ||
      persistedScope.checkoutId !== this.#binding.scope.checkoutId
    ) {
      throw new ScopedStoreCorruptionError('mission pane scope');
    }
    if (
      executionScope.installationId !== this.#binding.scope.installationId ||
      executionScope.projectId !== this.#binding.scope.projectId ||
      executionScope.checkoutId !== this.#binding.scope.checkoutId
    ) {
      throw new ScopedStoreCorruptionError('mission pane execution scope');
    }

    return {
      id: row.id,
      missionId: row.mission_id,
      adapterId: row.adapter_id,
      model: row.model ?? undefined,
      accountId: row.account_id ?? undefined,
      effort: row.effort ?? undefined,
      cwd: row.cwd ?? undefined,
      title: row.title,
      agentName: row.agent_name ?? undefined,
      workerIncarnationId,
      authoritySeal,
      visualTask,
      role: row.role,
      operatorOpened: row.operator_opened === 1 || undefined,
      paneId: row.pane_id ?? undefined,
      allowedTools: parseCapabilityList(
        row.allowed_tools_json,
        'mission pane allowed tools',
      ),
      allowedSkills: parseCapabilityList(
        row.allowed_skills_json,
        'mission pane allowed skills',
      ),
      readOnly,
      // Rebind local authority while preserving project/checkout ownership.
      scope: this.#binding.scope,
      executionScope,
      createdAt: row.created_at,
    };
  }
}

export function createScopedMissionPaneStore(
  runtimeManager: ProjectRuntimeManager,
  scope: ProjectExecutionScope,
  options: ScopedStoreOptions = {},
): ScopedMissionPaneStore {
  return new ScopedMissionPaneStore(runtimeManager, scope, options);
}
