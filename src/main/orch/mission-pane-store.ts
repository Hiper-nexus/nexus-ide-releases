import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { MissionPaneSpec } from '../../shared/orch-types';
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

const capabilityListSchema = z.array(z.string().min(1).max(128)).max(256);
const nullableCapabilityListSchema = capabilityListSchema.nullable();
const entityIdSchema = z.string().min(1).max(256);

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
    role: z.enum(['orchestrator', 'worker']).optional(),
    allowedTools: nullableCapabilityListSchema.optional(),
    allowedSkills: nullableCapabilityListSchema.optional(),
    paneId: entityIdSchema.optional(),
    executionScope: projectExecutionScopeSchema.optional(),
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
    created_at: z.number().int().nonnegative(),
  })
  .strict();

export type RecordMissionPaneInput = z.input<
  typeof recordMissionPaneInputSchema
>;

export interface ScopedMissionPaneSpec extends MissionPaneSpec {
  scope: ProjectExecutionScope;
  executionScope: ProjectExecutionScope;
}

const persistedPaneScopesSchema = z
  .object({
    schemaVersion: z.literal(2),
    coordinationScope: projectExecutionScopeSchema,
    executionScope: projectExecutionScopeSchema,
  })
  .strict();

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
  };
}

export class ScopedMissionPaneStore {
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
    const db = this.#binding.writeDatabase();
    const result = db.transaction(() => {
      const existing = this.#listFromDatabase(db, input.missionId).find(
        (spec) =>
          spec.adapterId === input.adapterId &&
          spec.model === input.model &&
          spec.accountId === input.accountId &&
          spec.cwd === input.cwd &&
          spec.title === title &&
          spec.role === role,
      );
      if (input.paneId !== undefined) {
        const owners = this.#findRowsByPaneId(db, input.paneId);
        if (owners.length > 1) {
          throw new ScopedStoreCorruptionError('mission pane ownership');
        }
        if (owners.length === 1 && owners[0].id !== existing?.id) {
          throw new Error('pane id already belongs to another mission pane');
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
        role,
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
        scope: this.#binding.scope,
        executionScope: input.executionScope ?? this.#binding.scope,
        createdAt: this.#binding.now(),
      };
      db.prepare(
        `INSERT INTO mission_panes
           (id, mission_id, adapter_id, model, account_id, effort, cwd, title,
            agent_name, role, pane_id, scope_json, allowed_tools_json,
            allowed_skills_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify({
          schemaVersion: 2,
          coordinationScope: this.#binding.scope,
          executionScope: spec.executionScope,
        }),
        encodeCapabilityList(spec.allowedTools),
        encodeCapabilityList(spec.allowedSkills),
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
    const paneId = existing.paneId ?? input.paneId;
    const allowedTools =
      existing.allowedTools === undefined
        ? input.allowedTools
        : existing.allowedTools;
    const allowedSkills =
      existing.allowedSkills === undefined
        ? input.allowedSkills
        : existing.allowedSkills;
    const hasChanges =
      paneId !== existing.paneId ||
      allowedTools !== existing.allowedTools ||
      allowedSkills !== existing.allowedSkills;
    if (!hasChanges) return { spec: cloneSpec(existing), changed: false };

    const updated: ScopedMissionPaneSpec = {
      ...existing,
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
        JSON.stringify({
          schemaVersion: 2,
          coordinationScope: this.#binding.scope,
          executionScope: updated.executionScope,
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
                allowed_tools_json, allowed_skills_json, created_at
         FROM mission_panes
         WHERE mission_id = ?
         ORDER BY CASE role WHEN 'orchestrator' THEN 0 ELSE 1 END,
                  created_at ASC, id ASC`,
      )
      .all(missionId);
    return rows.map((row) => this.#fromRow(row));
  }

  #findRowsByPaneId(
    db: Database.Database,
    paneId: string,
  ): ScopedMissionPaneSpec[] {
    const rows = db
      .prepare(
        `SELECT id, mission_id, adapter_id, model, account_id, effort, cwd,
                title, agent_name, role, pane_id, scope_json,
                allowed_tools_json, allowed_skills_json, created_at
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
    try {
      const raw = JSON.parse(row.scope_json) as unknown;
      const modern = persistedPaneScopesSchema.safeParse(raw);
      if (modern.success) {
        persistedScope = modern.data.coordinationScope;
        executionScope = modern.data.executionScope;
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
      role: row.role,
      paneId: row.pane_id ?? undefined,
      allowedTools: parseCapabilityList(
        row.allowed_tools_json,
        'mission pane allowed tools',
      ),
      allowedSkills: parseCapabilityList(
        row.allowed_skills_json,
        'mission pane allowed skills',
      ),
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
