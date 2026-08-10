import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { INITIAL_PROJECT_MIGRATIONS } from '../runtime/project-runtime-schema';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionStore } from './mission-store';
import { createScopedTaskStore } from './task-store';
import { compileIntentContract } from '../../shared/mission-intent';
import type { Squad } from '../../shared/orch-types';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

const squad: Squad = {
  id: 'delivery-squad',
  name: 'Delivery squad',
  createdAt: '2026-07-23T00:00:00.000Z',
  builtin: false,
  orchestratorInstructions: 'Coordinate.',
  agents: [
    {
      id: 'orchestrator',
      agentName: 'Maestro',
      category: 'orchestrator',
      cli: 'claude',
      model: 'claude-opus-4-1',
    },
    {
      id: 'api-worker',
      agentName: 'API Worker',
      category: 'executor',
      cli: 'codex',
      model: 'gpt-5.3-codex',
      effort: 'high',
      allowedTools: ['nexus_file_read', 'nexus_file_write'],
      allowedSkills: null,
    },
    {
      id: 'test-worker',
      agentName: 'Test Worker',
      category: 'reviewer',
      cli: 'grok',
      model: 'grok-4.5',
      allowedTools: ['nexus_file_read'],
      allowedSkills: ['review'],
    },
  ],
};

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({ baseDir, appVersion: '0.12.0-test' });
  managers.push(value);
  return value;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-task-store-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('scoped task store', () => {
  it('persists task mutations with explicit project and checkout ownership', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope).create({
      title: 'Mission',
    });
    const tasks = createScopedTaskStore(runtimeManager, scope, {
      now: () => 100,
      idFactory: () => 'task-a',
    });

    const task = tasks.create({
      missionId: mission.id,
      title: 'Review contracts',
      detail: 'Read every boundary.',
    });
    expect(task).toMatchObject({
      id: 'task-a',
      status: 'pending',
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
    });
    expect(tasks.update(task.id, { status: 'done', detail: 'Verified.' })).toMatchObject({
      status: 'done',
      detail: 'Verified.',
    });

    runtimeManager.close(scope);
    expect(createScopedTaskStore(runtimeManager, scope).list(mission.id)).toEqual([
      expect.objectContaining({ id: task.id, status: 'done' }),
    ]);
  });

  it('physically isolates identical task ids and observers by checkout', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({ checkoutId: 'checkout-a' });
    const scopeB = testProjectScope({ checkoutId: 'checkout-b' });
    const taskA = createScopedTaskStore(runtimeManager, scopeA, {
      idFactory: () => 'shared-task',
    });
    const taskB = createScopedTaskStore(runtimeManager, scopeB, {
      idFactory: () => 'shared-task',
    });
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    taskA.onChange(listenerA);
    taskB.onChange(listenerB);

    taskA.create({ title: 'A' });

    expect(taskA.list()).toHaveLength(1);
    expect(taskB.list()).toEqual([]);
    expect(listenerA).toHaveBeenCalledWith({
      projectId: scopeA.projectId,
      checkoutId: scopeA.checkoutId,
    });
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('fails closed when persistence is unavailable', () => {
    const runtimeManager = new ProjectRuntimeManager({
      baseDir,
      appVersion: '0.12.0-test',
      databaseFactory: (() => {
        throw new Error('native database unavailable');
      }) as never,
    });
    managers.push(runtimeManager);
    const tasks = createScopedTaskStore(runtimeManager, testProjectScope());

    expect(() => tasks.list()).toThrow(/no persistence fallback/i);
    expect(() => tasks.create({ title: 'lost' })).toThrow(/no persistence fallback/i);
  });

  it('creates a mission plan atomically and replays it with stable ids', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope);
    const contract = compileIntentContract({ goal: 'Plano durável', intentVersion: 2 });
    const mission = missions.create({
      title: 'Plan',
      squadId: squad.id,
      intentVersion: 2,
      intentState: 'dispatched',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const tasks = createScopedTaskStore(runtimeManager, scope, { now: () => 200 });
    const input = {
      missionId: mission.id,
      intentVersion: 2,
      squad: { id: squad.id, agents: squad.agents },
      rows: [
        {
          plannerId: 'api',
          title: 'API',
          detail: 'Implementar API',
          agentRef: 'API Worker',
          agentCategory: 'executor',
        },
        {
          plannerId: 'test',
          title: 'Test',
          detail: 'Cobrir API',
          agentRef: 'test-worker',
          agentCategory: 'reviewer',
        },
      ],
    } as const;

    const first = tasks.createPlanAtomically(input);
    const replay = tasks.createPlanAtomically(input);
    expect(replay.map((task) => task.id)).toEqual(first.map((task) => task.id));
    expect(tasks.list(mission.id)).toHaveLength(2);

    expect(() => tasks.createPlanAtomically({
      ...input,
      rows: [{
        plannerId: 'other',
        title: 'Divergent',
        detail: '',
        agentRef: 'api-worker',
        agentCategory: 'executor',
      }],
    })).toThrow(/conflict/i);
    expect(tasks.list(mission.id)).toHaveLength(2);

    expect(tasks.hasPlan(mission.id, 2)).toBe(true);
    expect(tasks.hasPlan(mission.id, 3)).toBe(false);
    // Plano selado noutra versão da intenção é ÓRFÃO, não ausência: devolver
    // `null` aqui era o que fazia o roteador oferecer CLI fora do roster.
    expect(tasks.listPlanIntentVersions(mission.id)).toEqual([2]);
    expect(() => tasks.getPlanReceipt(mission.id, 3)).toThrow(
      /orphan_sealed_plan/i,
    );
    const receipt = tasks.getPlanReceipt(mission.id, 2);
    expect(receipt).toMatchObject({
      version: 1,
      missionId: mission.id,
      intentVersion: 2,
      squadId: squad.id,
      createdAt: 200,
      tasks: [
        {
          plannerId: 'api',
          taskId: first[0]!.id,
          agentRef: 'api-worker',
          agentCategory: 'executor',
        },
        {
          plannerId: 'test',
          taskId: first[1]!.id,
          agentRef: 'test-worker',
          agentCategory: 'reviewer',
        },
      ],
    });
    expect(receipt?.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt?.rosterHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt?.agents).toEqual(squad.agents);

    expect(tasks.listPlannedTasks(mission.id, 2)).toEqual([
      expect.objectContaining({
        plannerId: 'api',
        agentRef: 'api-worker',
        agent: expect.objectContaining({ cli: 'codex' }),
        task: expect.objectContaining({ id: first[0]!.id }),
      }),
      expect.objectContaining({
        plannerId: 'test',
        agentRef: 'test-worker',
        agent: expect.objectContaining({ cli: 'grok' }),
        task: expect.objectContaining({ id: first[1]!.id }),
      }),
    ]);
    expect(tasks.getPlannedTask(first[1]!.id)).toEqual(
      expect.objectContaining({
        plannerId: 'test',
        agentRef: 'test-worker',
        agentCategory: 'reviewer',
      }),
    );
    expect(tasks.getPlannedTask('task-not-planned')).toBeNull();
    // A saída do órfão é re-selar: a leitura literal usada pelo planner nunca
    // pode ser barrada, senão a versão nova jamais consegue ganhar plano.
    expect(tasks.listPlannedTasks(mission.id, 3)).toEqual([]);
  });

  it('separa os três estados do plano: nunca teve, versão corrente e órfão', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope);
    const mission = missions.create({
      title: 'Órfão',
      squadId: squad.id,
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: compileIntentContract({
        goal: 'Plano que fica para trás',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const tasks = createScopedTaskStore(runtimeManager, scope);

    // (a) nunca selou plano → caminho livre, legítimo.
    expect(tasks.listPlanIntentVersions(mission.id)).toEqual([]);
    expect(tasks.getPlanReceipt(mission.id, 1)).toBeNull();

    tasks.createPlanAtomically({
      missionId: mission.id,
      intentVersion: 1,
      squad: { id: squad.id, agents: squad.agents },
      rows: [{
        plannerId: 'api',
        title: 'API',
        detail: 'Implementar API',
        agentRef: 'api-worker',
        agentCategory: 'executor',
      }],
    });

    // (b) plano na versão corrente → autoridade normal.
    expect(tasks.getPlanReceipt(mission.id, 1)).toMatchObject({
      intentVersion: 1,
    });

    // (c) a intenção avança e o plano fica para trás → ÓRFÃO, falha nomeada.
    expect(tasks.listPlanIntentVersions(mission.id)).toEqual([1]);
    expect(() => tasks.getPlanReceipt(mission.id, 2)).toThrow(
      /orphan_sealed_plan/i,
    );
    expect(() => tasks.getPlanReceipt(mission.id, 2)).toThrow(
      /versão 1 da intenção e a missão está na versão 2/,
    );
    expect(() => tasks.getPlanReceipt(mission.id, 2)).toThrow(
      /Retome a missão para re-selar/,
    );
  });

  it('seals a pending approved plan only with the exact main-owned preflight capability', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope);
    const approvalReviewSha256 = 'a'.repeat(64);
    const approvedAt = 101;
    const mission = missions.create({
      title: 'Approved preflight',
      squadId: squad.id,
      intentVersion: 2,
      intentState: 'ready_to_start',
      intentContract: {
        ...compileIntentContract({
          goal: 'Seal before dispatch',
          intentVersion: 2,
        }),
        approvedAt,
        approvalReviewSha256,
        dispatchedAt: 102,
      },
    });
    const tasks = createScopedTaskStore(runtimeManager, scope, { now: () => 202 });
    const input = {
      missionId: mission.id,
      intentVersion: 2,
      squad: { id: squad.id, agents: squad.agents },
      rows: [{
        plannerId: 'api',
        title: 'API',
        detail: 'Implementar',
        agentRef: 'api-worker',
        agentCategory: 'executor',
      }],
    } as const;

    expect(() => tasks.createPlanAtomically(input)).toThrow(
      /running mission or exact main-owned approved preflight/i,
    );
    expect(() => tasks.createPlanAtomically({
      ...input,
      approvedPreflight: {
        kind: 'approved-preflight',
        intentVersion: 2,
        approvedAt: approvedAt + 1,
        approvalReviewSha256,
      },
    })).toThrow(/running mission or exact main-owned approved preflight/i);
    expect(tasks.hasPlan(mission.id, 2)).toBe(false);
    expect(tasks.list(mission.id)).toEqual([]);

    const sealed = tasks.createPlanAtomically({
      ...input,
      approvedPreflight: {
        kind: 'approved-preflight',
        intentVersion: 2,
        approvedAt,
        approvalReviewSha256,
        dispatchedAt: 102,
      },
    });

    expect(sealed).toHaveLength(1);
    expect(tasks.hasPlan(mission.id, 2)).toBe(true);
    expect(missions.get(mission.id)).toMatchObject({
      status: 'pending',
      intentState: 'ready_to_start',
      intentVersion: 2,
      orchestratorSessionId: undefined,
      intentContract: {
        approvedAt,
        approvalReviewSha256,
        dispatchedAt: 102,
      },
    });
  });

  it('rejects non-members and category drift before persisting any task', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope);
    const mission = missions.create({
      title: 'Plan',
      squadId: squad.id,
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: compileIntentContract({
        goal: 'Membership',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const tasks = createScopedTaskStore(runtimeManager, scope);
    const base = {
      missionId: mission.id,
      intentVersion: 1,
      squad: { id: squad.id, agents: squad.agents },
    } as const;

    expect(() => tasks.createPlanAtomically({
      ...base,
      rows: [{
        plannerId: 'alien',
        title: 'Alien',
        detail: '',
        agentRef: 'not-in-roster',
        agentCategory: 'executor',
      }],
    })).toThrow(/roster|member/i);
    expect(() => tasks.createPlanAtomically({
      ...base,
      rows: [{
        plannerId: 'api',
        title: 'API',
        detail: '',
        agentRef: 'api-worker',
        agentCategory: 'reviewer',
      }],
    })).toThrow(/category/i);
    expect(() => tasks.createPlanAtomically({
      ...base,
      rows: [{
        plannerId: 'coordinate',
        title: 'Coordinate',
        detail: '',
        agentRef: 'orchestrator',
        agentCategory: 'orchestrator',
      }],
    })).toThrow(/orchestrator/i);
    expect(tasks.hasPlan(mission.id, 1)).toBe(false);
    expect(tasks.list(mission.id)).toEqual([]);
  });

  it('makes sealed task fields immutable and detects physical row tampering', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope);
    const mission = missions.create({
      title: 'Immutable plan',
      squadId: squad.id,
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: compileIntentContract({
        goal: 'Immutable planned tasks',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const tasks = createScopedTaskStore(runtimeManager, scope);
    const [task] = tasks.createPlanAtomically({
      missionId: mission.id,
      intentVersion: 1,
      squad: { id: squad.id, agents: squad.agents },
      rows: [{
        plannerId: 'api',
        title: 'API',
        detail: 'Implementar',
        agentRef: 'api-worker',
        agentCategory: 'executor',
      }],
    });

    expect(() => tasks.update(task!.id, { status: 'running' })).toThrow(
      /sealed planned task|dispatcher/i,
    );
    expect(() => tasks.update(task!.id, { title: 'Changed' })).toThrow(
      /sealed planned task|dispatcher/i,
    );
    expect(() => tasks.update(task!.id, { detail: 'Changed' })).toThrow(
      /sealed planned task|dispatcher/i,
    );

    const db = runtimeManager.open(scope).db;
    db.prepare(`UPDATE tasks SET status = 'running' WHERE id = ?`).run(task!.id);
    expect(tasks.getPlanReceipt(mission.id, 1)).not.toBeNull();

    db.prepare(`UPDATE tasks SET detail = 'tampered' WHERE id = ?`).run(task!.id);
    expect(() => tasks.getPlanReceipt(mission.id, 1)).toThrow(
      /invalid task plan receipt/i,
    );
  });

  it('rejects roster drift on replay and detects persisted receipt tampering', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtimeManager, scope);
    const mission = missions.create({
      title: 'Plan',
      squadId: squad.id,
      intentVersion: 4,
      intentState: 'dispatched',
      intentContract: compileIntentContract({
        goal: 'Tamper fence',
        intentVersion: 4,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const tasks = createScopedTaskStore(runtimeManager, scope);
    const input = {
      missionId: mission.id,
      intentVersion: 4,
      squad: { id: squad.id, agents: squad.agents },
      rows: [{
        plannerId: 'api',
        title: 'API',
        detail: 'Implementar',
        agentRef: 'api-worker',
        agentCategory: 'executor',
      }],
    } as const;
    tasks.createPlanAtomically(input);

    expect(() => tasks.createPlanAtomically({
      ...input,
      squad: {
        id: squad.id,
        agents: squad.agents.map((agent) =>
          agent.id === 'api-worker'
            ? { ...agent, model: 'gpt-tampered' }
            : agent,
        ),
      },
    })).toThrow(/conflict|roster/i);

    runtimeManager.open(scope).db.prepare(
      `UPDATE mission_task_plans
       SET planner_json = replace(planner_json, '"executor"', '"reviewer"')
       WHERE mission_id = ? AND intent_version = ?`,
    ).run(mission.id, 4);
    expect(() => tasks.getPlanReceipt(mission.id, 4)).toThrow(
      /invalid task plan receipt/i,
    );
    expect(() => tasks.getPlannedTask(tasks.list(mission.id)[0]!.id)).toThrow(
      /invalid task plan receipt/i,
    );
  });

  it('installs append-only roster and worker-incarnation contract columns', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const db = runtimeManager.open(scope).db;
    const columns = (table: string) =>
      new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .map((column) => column.name),
      );

    expect(columns('mission_task_plans')).toEqual(expect.objectContaining(
      new Set(['squad_id', 'roster_hash', 'roster_snapshot_json']),
    ));
    expect(columns('task_dispatch_queue')).toEqual(expect.objectContaining(
      new Set([
        'agent_ref',
        'agent_category',
        'roster_hash',
        'route_contract_json',
        'worker_incarnation_id',
      ]),
    ));
    expect(columns('handoffs')).toEqual(expect.objectContaining(
      new Set(['worker_incarnation_id']),
    ));
    expect(
      db.prepare(
        `SELECT migration_id, schema_version
         FROM __nexus_schema_migrations WHERE schema_version = 17`,
      ).get(),
    ).toEqual({
      migration_id: '017-task-plan-roster-contract',
      schema_version: 17,
    });
    expect(
      db.prepare(
        `SELECT migration_id, schema_version
         FROM __nexus_schema_migrations WHERE schema_version = 18`,
      ).get(),
    ).toEqual({
      migration_id: '018-worker-incarnation-fence',
      schema_version: 18,
    });
  });

  it('upgrades a migration-016 database without rewriting its legacy plans', () => {
    const scope = testProjectScope();
    const legacyManager = new ProjectRuntimeManager({
      baseDir,
      appVersion: '0.19.27-test',
      migrations: INITIAL_PROJECT_MIGRATIONS.filter(
        ({ schemaVersion }) => schemaVersion <= 16,
      ),
    });
    managers.push(legacyManager);
    const mission = { id: 'mission-legacy-016' };
    const legacyDb = legacyManager.open(scope).db;
    legacyDb
      .prepare(
        `INSERT INTO missions
           (id, title, description, status, squad_id, milestones_json,
            orch_session_id, created_at, updated_at, learnings, intent_state,
            intent_contract_json, intent_version)
         VALUES (?, ?, '', 'running', ?, '[]', NULL, 100, 100, '',
                 'dispatched', ?, 1)`,
      )
      .run(
        mission.id,
        'Legacy sealed plan',
        squad.id,
        JSON.stringify(
          compileIntentContract({
            goal: 'Upgrade preserving data',
            intentVersion: 1,
          }),
        ),
      );
    legacyDb.prepare(
      `INSERT INTO mission_task_plans
         (mission_id, intent_version, plan_hash, planner_json, created_at)
       VALUES (?, 1, ?, ?, 123)`,
    ).run(mission.id, 'a'.repeat(64), '[{"legacy":true}]');
    legacyManager.closeAll();

    const upgradedManager = manager();
    const db = upgradedManager.open(scope).db;
    expect(
      db.prepare(
        `SELECT plan_hash, planner_json, created_at, squad_id, roster_hash,
                roster_snapshot_json
         FROM mission_task_plans WHERE mission_id = ?`,
      ).get(mission.id),
    ).toEqual({
      plan_hash: 'a'.repeat(64),
      planner_json: '[{"legacy":true}]',
      created_at: 123,
      squad_id: null,
      roster_hash: null,
      roster_snapshot_json: null,
    });
    expect(() =>
      createScopedTaskStore(upgradedManager, scope).getPlanReceipt(mission.id, 1)
    ).toThrow(/invalid task plan receipt/i);
  });
});
