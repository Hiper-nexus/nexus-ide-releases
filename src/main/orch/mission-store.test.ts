import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  INITIAL_PROJECT_MIGRATIONS,
  createProjectMigration,
} from '../runtime/project-runtime-schema';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionStore } from './mission-store';
import {
  compileIntentContract,
  hasCurrentDispatchAuthority,
} from '../../shared/mission-intent';
import { plannedTaskId } from './task-store';
import {
  MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_MARKER,
  MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_REASON,
} from './mission-orchestrator-exit-policy';
import { hashMissionIntentAuthority } from './mission-pane-authority';
import { RETIRED_ROSTER_ROUTE_MARKER } from '../../shared/retired-adapter-policy';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.12.0-test',
  });
  managers.push(value);
  return value;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mission-store-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('scoped mission store', () => {
  it('publishes v+1 for native reapproval without rewriting dead-graph history', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'dead-graph-reapproval' });
    let now = 100;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => ++now,
      idFactory: () => 'mission-dead-graph',
    });
    const contract = {
      ...compileIntentContract({
        goal: 'Entregar o fluxo completo com segurança',
        intentVersion: 2,
        acceptanceCriteria: ['Fluxo implementado', 'Fluxo validado'],
      }),
      approvedAt: 50,
      approvalReviewSha256: 'a'.repeat(64),
      dispatchedAt: 60,
      squadRevisionHash: 'b'.repeat(64),
      orchestratorRuntime: {
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        readOnly: false as const,
        nativeReadOnly: true as const,
      },
      spentSteps: 7,
      spentTokens: 9_000,
    };
    const mission = store.create({
      title: 'Dead graph',
      squadId: 'squad-runtime-v2',
      intentState: 'executing',
      intentVersion: 2,
      intentContract: contract,
      orchestratorSessionId: 'session-v2',
    });
    store.setStatus(mission.id, 'running');
    const db = runtimeManager.open(scope).db;
    db.prepare(
      `INSERT INTO tasks
         (id, mission_id, title, detail, status, priority, created_at, updated_at)
       VALUES ('task-v2', ?, 'Executar v2', '', 'running', 0, 1, 1)`,
    ).run(mission.id);
    db.prepare(
      `INSERT INTO task_dispatch_queue
         (id, task_id, mission_id, intent_version, state,
          lease_token_hash, lease_owner, lease_expires_at, worker_id,
          created_at, updated_at)
       VALUES (
         'dispatch-v2', 'task-v2', ?, 2, 'running',
         ?, 'main', 10_000, 'worker-v2', 1, 1
       )`,
    ).run(mission.id, 'c'.repeat(64));

    const blocked = store.block(mission.id, 'technical');
    expect(blocked).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
      intentVersion: 2,
    });
    if (!blocked) throw new Error('mission must exist');
    const historyBefore = {
      tasks: db
        .prepare('SELECT * FROM tasks WHERE mission_id = ? ORDER BY id')
        .all(mission.id),
      dispatches: db
        .prepare(
          'SELECT * FROM task_dispatch_queue WHERE mission_id = ? ORDER BY id',
        )
        .all(mission.id),
    };

    const reapproval = store.publishDeadGraphReapprovalRevision(
      mission.id,
      blocked,
    );

    expect(reapproval).toMatchObject({
      status: 'pending',
      intentState: 'ready_to_start',
      intentVersion: 3,
      orchestratorSessionId: undefined,
      milestones: [
        {
          id: 'step-1',
          label: 'Fluxo implementado',
          status: 'pending',
          evidenceIds: [],
        },
        {
          id: 'step-2',
          label: 'Fluxo validado',
          status: 'pending',
          evidenceIds: [],
        },
      ],
      intentContract: {
        goal: contract.goal,
        intentVersion: 3,
      },
    });
    expect(reapproval.intentContract).not.toHaveProperty('approvedAt');
    expect(reapproval.intentContract).not.toHaveProperty(
      'approvalReviewSha256',
    );
    expect(reapproval.intentContract).not.toHaveProperty('dispatchedAt');
    expect(reapproval.intentContract).not.toHaveProperty('squadRevisionHash');
    expect(reapproval.intentContract).not.toHaveProperty(
      'orchestratorRuntime',
    );
    expect(reapproval.intentContract).not.toHaveProperty('spentSteps');
    expect(reapproval.intentContract).not.toHaveProperty('spentTokens');
    const oldPlanTaskId = plannedTaskId(mission.id, 2, 'implementation');
    const newPlanTaskId = plannedTaskId(mission.id, 3, 'implementation');
    expect(newPlanTaskId).not.toBe(oldPlanTaskId);
    expect(plannedTaskId(mission.id, 3, 'implementation')).toBe(
      newPlanTaskId,
    );
    expect({
      tasks: db
        .prepare('SELECT * FROM tasks WHERE mission_id = ? ORDER BY id')
        .all(mission.id),
      dispatches: db
        .prepare(
          'SELECT * FROM task_dispatch_queue WHERE mission_id = ? ORDER BY id',
        )
        .all(mission.id),
    }).toEqual(historyBefore);
    expect(historyBefore.tasks).toEqual([
      expect.objectContaining({ id: 'task-v2', status: 'failed' }),
    ]);
    expect(historyBefore.dispatches).toEqual([
      expect.objectContaining({ id: 'dispatch-v2', state: 'superseded' }),
    ]);

    expect(() =>
      store.publishDeadGraphReapprovalRevision(mission.id, blocked),
    ).toThrow(/CAS changed/i);
  });

  it('refuses dead-graph revision publication without terminal dispatch and pane proof', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'dead-graph-fail-closed' });
    let sequence = 0;
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: (prefix) => `${prefix}-${++sequence}`,
    });
    const contract = {
      ...compileIntentContract({
        goal: 'Não duplicar execução',
        intentVersion: 1,
      }),
      approvedAt: 1,
      dispatchedAt: 2,
    };
    const shell = store.create({
      title: 'Bootstrap only',
      squadId: 'squad-a',
      intentState: 'executing',
      intentVersion: 1,
      intentContract: contract,
    });
    store.setStatus(shell.id, 'running');
    const bootstrapBlocked = store.update(shell.id, { status: 'blocked' });
    if (!bootstrapBlocked) throw new Error('mission must exist');
    expect(() =>
      store.publishDeadGraphReapprovalRevision(shell.id, bootstrapBlocked),
    ).toThrow(/invalidated current dispatch/i);

    const db = runtimeManager.open(scope).db;
    db.prepare(
      `INSERT INTO tasks
         (id, mission_id, title, detail, status, priority, created_at, updated_at)
       VALUES ('task-terminal', ?, 'Terminal', '', 'failed', 0, 1, 1)`,
    ).run(shell.id);
    db.prepare(
      `INSERT INTO task_dispatch_queue
         (id, task_id, mission_id, intent_version, state,
          lease_token_hash, lease_owner, lease_expires_at, worker_id,
          created_at, updated_at)
       VALUES (
         'dispatch-terminal', 'task-terminal', ?, 1, 'failed',
         ?, 'main', 10_000, 'worker-terminal', 1, 1
       )`,
    ).run(shell.id, 'd'.repeat(64));
    db.prepare(
      `INSERT INTO mission_panes
         (id, mission_id, adapter_id, title, role, scope_json, created_at)
       VALUES (
         'pane-row-terminal', ?, 'codex', 'Old worker', 'worker', ?, 1
       )`,
    ).run(
      shell.id,
      JSON.stringify({
        schemaVersion: 2,
        coordinationScope: scope,
        executionScope: scope,
      }),
    );

    expect(() =>
      store.publishDeadGraphReapprovalRevision(shell.id, bootstrapBlocked),
    ).toThrow(/proven pane teardown/i);
    expect(store.get(shell.id)).toMatchObject({
      status: 'blocked',
      intentVersion: 1,
    });
  });

  it('publishes a fresh review revision for a retired sealed route without rewriting its squad or old plan', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'retired-route-reapproval' });
    let now = 100;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => ++now,
      idFactory: () => 'mission-retired-route',
    });
    const contract = {
      ...compileIntentContract({
        goal: 'Continuar uma missão criada antes da remoção do provider',
        intentVersion: 4,
      }),
      approvedAt: 80,
      dispatchedAt: 90,
    };
    const shell = store.create({
      title: 'Legacy route',
      description:
        `${RETIRED_ROSTER_ROUTE_MARKER} O seal antigo exige revisão do squad.`,
      squadId: 'squad-legacy',
      intentState: 'executing',
      intentVersion: 4,
      intentContract: contract,
    });
    store.setStatus(shell.id, 'running');
    const blocked = store.update(shell.id, {
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    if (!blocked) throw new Error('mission must exist');

    const reapproval = store.publishDeadGraphReapprovalRevision(
      shell.id,
      blocked,
    );

    expect(reapproval).toMatchObject({
      status: 'pending',
      intentState: 'ready_to_start',
      intentVersion: 5,
      squadId: 'squad-legacy',
      intentContract: {
        goal: contract.goal,
        intentVersion: 5,
      },
    });
    expect(reapproval.intentContract).not.toHaveProperty('approvedAt');
    expect(reapproval.intentContract).not.toHaveProperty('dispatchedAt');
    expect(() =>
      store.publishDeadGraphReapprovalRevision(shell.id, blocked),
    ).toThrow(/CAS changed/i);
  });

  it('promotes plan with a main-only squad CAS and keeps renderer patches unable to rebind it', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'plan-promotion-cas' });
    let now = 100;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => ++now,
      idFactory: () => 'mission-plan-cas',
    });
    const planContract = {
      ...compileIntentContract({
        goal: 'Produzir PRD antes da implementação',
        intentVersion: 1,
        lane: 'plan',
        acceptanceCriteria: ['PRD validado', 'Arquitetura validada'],
      }),
      approvedAt: 90,
      dispatchedAt: 95,
    };
    const plan = store.create({
      title: 'Planejamento',
      squadId: 'mission-runtime-plan-v1',
      intentState: 'dispatched',
      intentVersion: 1,
      intentContract: planContract,
    });
    const standardContract = {
      ...compileIntentContract({
        goal: planContract.goal,
        intentVersion: 2,
        lane: 'standard',
        acceptanceCriteria: planContract.acceptanceCriteria,
      }),
      approvedAt: 110,
      squadRevisionHash: 'a'.repeat(64),
    };

    expect(() =>
      store.update(plan.id, { squadId: 'renderer-forged' } as never),
    ).toThrow(/Unrecognized key.*squadId/i);

    const promoted = store.commitPlanPromotionRevision(
      plan.id,
      plan,
      'agentic-runtime-standard-v2',
      standardContract,
    );
    expect(promoted).toMatchObject({
      squadId: 'agentic-runtime-standard-v2',
      status: 'pending',
      intentState: 'ready_to_start',
      intentVersion: 2,
      milestones: [
        {
          id: 'step-1',
          label: 'PRD validado',
          status: 'pending',
          evidenceIds: [],
        },
        {
          id: 'step-2',
          label: 'Arquitetura validada',
          status: 'pending',
          evidenceIds: [],
        },
      ],
    });
    expect(promoted.intentContract).toMatchObject({
      lane: 'standard',
      intentVersion: 2,
      squadRevisionHash: 'a'.repeat(64),
    });

    expect(() =>
      store.commitPlanPromotionRevision(
        plan.id,
        plan,
        'agentic-runtime-stale-v3',
        { ...standardContract, intentVersion: 2 },
      ),
    ).toThrow(/CAS changed/i);
    expect(store.get(plan.id)?.squadId).toBe('agentic-runtime-standard-v2');
  });

  it('atomically rebinds the runtime squad and its approved authority hash', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({
      checkoutId: 'runtime-squad-authority-cas',
    });
    let now = 200;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => ++now,
      idFactory: () => 'mission-runtime-authority-cas',
    });
    const contract = {
      ...compileIntentContract({
        goal: 'Executar com o roster vivo recuperado',
        intentVersion: 1,
      }),
      approvedAt: 190,
      squadRevisionHash: 'a'.repeat(64),
    };
    const mission = store.create({
      title: 'Recuperação D1',
      squadId: 'catalog-squad-stale',
      intentState: 'ready_to_start',
      intentVersion: 1,
      intentContract: contract,
    });
    const reboundContract = {
      ...contract,
      squadRevisionHash: 'b'.repeat(64),
    };

    const rebound = store.rebindMissionSquadAuthority(
      mission.id,
      mission,
      'nexus-story-impl',
      reboundContract,
    );

    expect(rebound).toMatchObject({
      squadId: 'nexus-story-impl',
      intentVersion: 1,
    });
    expect(rebound.intentContract?.squadRevisionHash).toBe('b'.repeat(64));
    expect(() =>
      store.rebindMissionSquadAuthority(
        mission.id,
        mission,
        'agentic-runtime-22222222-2222-4222-8222-222222222222',
        reboundContract,
      ),
    ).toThrow(/CAS changed/i);
  });

  it('rejects intentVersion skew and clones nested contract arrays', () => {
    const runtimeManager = manager();
    const store = createScopedMissionStore(runtimeManager, testProjectScope());
    const contract = {
      ...compileIntentContract({ goal: 'Ship safely', intentVersion: 2 }),
      deniedTools: ['terminal_run'],
      attachmentPaths: ['/Users/me/.nexus/dropped/proof.png'],
    };
    expect(() =>
      store.create({
        title: 'Skewed',
        intentVersion: 1,
        intentContract: contract,
      }),
    ).toThrow(/version must match/i);

    const created = store.create({
      title: 'Current',
      intentState: 'ready_to_start',
      intentVersion: 2,
      intentContract: contract,
    });
    expect(created.intentContract?.deniedTools).toEqual(['terminal_run']);
    expect(created.intentContract?.deniedTools).not.toBe(contract.deniedTools);
    expect(created.intentContract?.attachmentPaths).toEqual(
      contract.attachmentPaths,
    );
    expect(created.intentContract?.attachmentPaths).not.toBe(
      contract.attachmentPaths,
    );
    contract.attachmentPaths.push('/tmp/forged-after-create');
    expect(store.get(created.id)?.intentContract?.attachmentPaths).toEqual([
      '/Users/me/.nexus/dropped/proof.png',
    ]);

    runtimeManager.close(testProjectScope());
    const reopened = createScopedMissionStore(
      runtimeManager,
      testProjectScope(),
    );
    expect(reopened.get(created.id)?.intentContract?.attachmentPaths).toEqual([
      '/Users/me/.nexus/dropped/proof.png',
    ]);
  });

  it('physically isolates projects and returns explicit scope coordinates', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({
      projectId: 'project-a',
      checkoutId: 'checkout-a',
    });
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'checkout-b',
    });
    const storeA = createScopedMissionStore(runtimeManager, scopeA);
    const storeB = createScopedMissionStore(runtimeManager, scopeB);

    const mission = storeA.create({ title: 'Only A', milestones: ['one'] });

    expect(mission).toMatchObject({
      title: 'Only A',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
    });
    expect(mission.milestones).toEqual([
      { id: 'step-1', label: 'one', status: 'pending', evidenceIds: [] },
    ]);
    expect(storeA.list()).toEqual([mission]);
    expect(storeB.list()).toEqual([]);
    expect(runtimeManager.open(scopeA).databasePath).not.toBe(
      runtimeManager.open(scopeB).databasePath,
    );
  });

  it('persists every mutation and never exposes mutable stored arrays', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => 42,
      idFactory: () => 'mission-stable',
    });
    const created = store.create({
      title: 'Review',
      milestones: ['design'],
      orchestratorSessionId: 'session-a',
    });
    created.milestones.push({
      id: 'mutated',
      label: 'mutated-outside',
      status: 'pending',
      evidenceIds: [],
    });

    expect(store.get('mission-stable')?.milestones).toEqual([
      { id: 'step-1', label: 'design', status: 'pending', evidenceIds: [] },
    ]);
    expect(
      store.update('mission-stable', { milestones: ['tested'] }),
    ).toMatchObject({
      status: 'pending',
      milestones: [
        { id: 'step-1', label: 'tested', status: 'pending', evidenceIds: [] },
      ],
    });
    expect(store.setStatus('mission-stable', 'running')?.status).toBe(
      'running',
    );
    expect(
      store.setOrchestratorSession('mission-stable', 'session-b'),
    ).toMatchObject({
      orchestratorSessionId: 'session-b',
    });
    expect(
      store.clearOrchestratorSessionIfMatches('mission-stable', 'session-a'),
    ).toBeNull();
    expect(store.get('mission-stable')).toMatchObject({
      orchestratorSessionId: 'session-b',
    });
    expect(
      store.clearOrchestratorSessionIfMatches('mission-stable', 'session-b'),
    ).toMatchObject({
      orchestratorSessionId: undefined,
    });
    store.setOrchestratorSession('mission-stable', 'session-b');

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.get('mission-stable')).toMatchObject({
      status: 'running',
      orchestratorSessionId: 'session-b',
      milestones: [
        { id: 'step-1', label: 'tested', status: 'pending', evidenceIds: [] },
      ],
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
    });
    expect(reopened.remove('mission-stable')).toBe(true);
    expect(reopened.remove('mission-stable')).toBe(false);
  });

  it('remove somente a revisão durável exata observada antes do teardown', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'mission-remove-cas' });
    let now = 100;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => ++now,
      idFactory: () => 'mission-remove-cas',
    });
    const observed = store.create({
      title: 'Remoção protegida',
      intentState: 'awaiting_goal',
    });
    const changed = store.update(observed.id, {
      description: 'Recuperação rearmou a missão durante o teardown.',
    });
    if (!changed) throw new Error('mission must exist');

    expect(store.removeIfUnchanged(observed.id, observed)).toBe('changed');
    expect(store.get(observed.id)).toEqual(changed);
    expect(store.removeIfUnchanged(changed.id, changed)).toBe('removed');
    expect(store.get(observed.id)).toBeNull();
    expect(store.removeIfUnchanged(changed.id, changed)).toBe('missing');
  });

  it('rejects stale lifecycle CAS without mutation or emission', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'lifecycle-cas-stale' });
    let now = 400;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => ++now,
      idFactory: () => 'mission-lifecycle-stale',
    });
    const mission = store.create({
      title: 'Lifecycle stale',
      description: 'Durable current description',
      intentState: 'executing',
      intentVersion: 4,
    });
    const running = store.setStatus(mission.id, 'running')!;
    const db = runtimeManager.open(scope).db;
    db.prepare(
      `INSERT INTO tasks
         (id, mission_id, title, detail, status, priority, created_at, updated_at)
       VALUES ('task-lifecycle-stale', ?, 'Stale lifecycle task', '', 'running', 0, 1, 1)`,
    ).run(mission.id);
    db.prepare(
      `INSERT INTO task_dispatch_queue
         (id, task_id, mission_id, intent_version, state,
          lease_token_hash, lease_owner, lease_expires_at, worker_id,
          created_at, updated_at)
       VALUES (
         'dispatch-lifecycle-stale', 'task-lifecycle-stale', ?, 4, 'running',
         ?, 'main', 10_000, 'worker-lifecycle-stale', 1, 1
       )`,
    ).run(mission.id, 'f'.repeat(64));
    const before = store.get(mission.id);
    const changed = vi.fn();
    const unsubscribe = store.onChange(changed);

    expect(
      store.transitionLifecycle(
        mission.id,
        {
          updatedAt: running.updatedAt - 1,
          intentVersion: running.intentVersion!,
        },
        { status: 'blocked', intentState: 'blocked_technical' },
      ),
    ).toBeNull();
    expect(
      store.transitionLifecycle(
        mission.id,
        {
          updatedAt: running.updatedAt,
          intentVersion: running.intentVersion! + 1,
        },
        { status: 'blocked', intentState: 'blocked_technical' },
      ),
    ).toBeNull();

    expect(store.get(mission.id)).toEqual(before);
    expect(
      runtimeManager
        .open(scope)
        .db.prepare(
          'SELECT status, intent_state, description, updated_at FROM missions WHERE id = ?',
        )
        .get(mission.id),
    ).toEqual({
      status: 'running',
      intent_state: 'executing',
      description: 'Durable current description',
      updated_at: running.updatedAt,
    });
    expect(
      db.prepare('SELECT status, updated_at FROM tasks WHERE id = ?').get(
        'task-lifecycle-stale',
      ),
    ).toEqual({ status: 'running', updated_at: 1 });
    expect(
      db.prepare(
        'SELECT state, last_error, revision, updated_at FROM task_dispatch_queue WHERE id = ?',
      ).get('dispatch-lifecycle-stale'),
    ).toEqual({
      state: 'running',
      last_error: null,
      revision: 1,
      updated_at: 1,
    });
    expect(changed).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('persists the canonical completion result atomically and clears it when work resumes', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'mission-result-cas' });
    let now = 450;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => ++now,
      idFactory: () => 'mission-result-cas',
    });
    const mission = store.create({
      title: 'Canonical result',
      intentState: 'executing',
      intentVersion: 2,
    });
    const running = store.setStatus(mission.id, 'running')!;
    const result = {
      outcome: 'success' as const,
      summary: 'Entrega validada pelo motor principal.',
      evidenceIds: ['evidence-quality-gate'],
      artifactRefs: ['0123456789abcdef0123456789abcdef01234567'],
    };

    const completed = store.transitionLifecycle(
      mission.id,
      {
        updatedAt: running.updatedAt,
        intentVersion: running.intentVersion!,
      },
      {
        status: 'done',
        intentState: 'done',
        learnings: '## Conclusão\nEntrega validada.',
        result,
      },
    );

    expect(completed?.result).toEqual(result);
    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.get(mission.id)?.result).toEqual(result);

    const resumed = reopened.transitionLifecycle(
      mission.id,
      {
        updatedAt: completed!.updatedAt,
        intentVersion: completed!.intentVersion!,
      },
      { status: 'running', intentState: 'executing' },
    );
    expect(resumed?.result).toBeUndefined();
    expect(
      runtimeManager
        .open(scope)
        .db.prepare('SELECT result_json FROM missions WHERE id = ?')
        .get(mission.id),
    ).toEqual({ result_json: null });
  });

  it('requires a canonical result for every terminal lifecycle commit', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'mission-result-required' });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-result-required',
    });
    const mission = store.create({
      title: 'Result-required completion',
      intentState: 'executing',
      intentVersion: 1,
    });
    const running = store.setStatus(mission.id, 'running')!;

    expect(() =>
      store.transitionLifecycle(
        mission.id,
        {
          updatedAt: running.updatedAt,
          intentVersion: running.intentVersion!,
        },
        {
          status: 'done',
          intentState: 'done',
          learnings: 'Completion without canonical output must fail closed.',
        },
      ),
    ).toThrow(/canonical.*result/i);
    expect(store.get(mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
  });

  it('emits nested lifecycle changes only after the enclosing transaction commits', async () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'mission-nested-commit' });
    let now = 475;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => ++now,
      idFactory: () => 'mission-nested-commit',
    });
    const mission = store.create({
      title: 'Nested verified completion',
      intentState: 'executing',
      intentVersion: 1,
    });
    const running = store.setStatus(mission.id, 'running')!;
    const changed = vi.fn();
    const unsubscribe = store.onChange(changed);
    const db = runtimeManager.open(scope).db;
    const result = {
      outcome: 'success' as const,
      summary: 'Nested completion committed with its verification frame.',
      evidenceIds: [],
      artifactRefs: [],
    };

    expect(() =>
      db
        .transaction(() => {
          store.transitionLifecycle(
            mission.id,
            {
              updatedAt: running.updatedAt,
              intentVersion: running.intentVersion!,
            },
            {
              status: 'done',
              intentState: 'done',
              learnings: 'Rolled back verification.',
              result,
            },
          );
          throw new Error('rollback outer verification');
        })
        .immediate(),
    ).toThrow(/rollback outer verification/);
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    expect(store.get(mission.id)).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });

    const completed = db
      .transaction(() =>
        store.transitionLifecycle(
          mission.id,
          {
            updatedAt: running.updatedAt,
            intentVersion: running.intentVersion!,
          },
          {
            status: 'done',
            intentState: 'done',
            learnings: 'Committed verification.',
            result,
          },
        ),
      )
      .immediate();
    expect(changed).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(changed).toHaveBeenCalledOnce();
    expect(completed?.result).toEqual(result);
    expect(store.get(mission.id)?.result).toEqual(result);
    unsubscribe();
  });

  it('rejects terminal completion through generic status mutations', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'mission-done-authority' });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-done-authority',
    });
    const mission = store.create({
      title: 'Only MissionEngine may complete',
      intentState: 'executing',
      intentVersion: 1,
    });
    store.setStatus(mission.id, 'running');

    expect(() => store.setStatus(mission.id, 'done')).toThrow(
      /verified completion|MissionEngine/i,
    );
    expect(() => store.update(mission.id, { status: 'done' })).toThrow(
      /verified completion|MissionEngine/i,
    );
    const unchanged = store.get(mission.id);
    expect(unchanged).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
    expect(unchanged?.result).toBeUndefined();
  });

  it('atomically persists the start-request marker with the lifecycle fence', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'mission-start-request-cas' });
    let now = 500;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => ++now,
      idFactory: () => 'mission-start-request-cas',
    });
    const contract = {
      ...compileIntentContract({
        goal: 'Execute only after the operator starts this reviewed mission',
        intentVersion: 1,
      }),
      approvedAt: 100,
      approvalReviewSha256: 'a'.repeat(64),
    };
    const mission = store.create({
      title: 'Start request CAS',
      intentState: 'ready_to_start',
      intentVersion: 1,
      intentContract: contract,
    });

    const sealed = store.transitionLifecycle(
      mission.id,
      {
        updatedAt: mission.updatedAt,
        intentVersion: mission.intentVersion!,
      },
      {
        status: 'pending',
        intentState: 'ready_to_start',
        intentContract: { ...contract, dispatchedAt: 501 },
      },
    );

    expect(sealed).toMatchObject({
      status: 'pending',
      intentState: 'ready_to_start',
      intentContract: {
        approvalReviewSha256: 'a'.repeat(64),
        dispatchedAt: 501,
      },
    });
    expect(store.get(mission.id)?.intentContract?.dispatchedAt).toBe(501);
    expect(
      store.transitionLifecycle(
        mission.id,
        {
          updatedAt: mission.updatedAt,
          intentVersion: mission.intentVersion!,
        },
        {
          status: 'pending',
          intentState: 'ready_to_start',
          intentContract: { ...contract, dispatchedAt: 502 },
        },
      ),
    ).toBeNull();
    expect(store.get(mission.id)?.intentContract?.dispatchedAt).toBe(501);
  });

  it('atomically transitions lifecycle, preserves description, and revokes dispatch authority', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'lifecycle-cas-success' });
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => 500,
      idFactory: () => 'mission-lifecycle-success',
    });
    const mission = store.create({
      title: 'Lifecycle success',
      description: 'Keep this diagnosis',
      intentState: 'executing',
      intentVersion: 2,
    });
    const running = store.setStatus(mission.id, 'running')!;
    const db = runtimeManager.open(scope).db;
    db.prepare(
      `INSERT INTO tasks
         (id, mission_id, title, detail, status, priority, created_at, updated_at)
       VALUES ('task-lifecycle', ?, 'Lifecycle task', '', 'running', 0, 1, 1)`,
    ).run(mission.id);
    db.prepare(
      `INSERT INTO task_dispatch_queue
         (id, task_id, mission_id, intent_version, state,
          lease_token_hash, lease_owner, lease_expires_at, worker_id,
          created_at, updated_at)
       VALUES (
         'dispatch-lifecycle', 'task-lifecycle', ?, 2, 'running',
         ?, 'main', 10_000, 'worker-lifecycle', 1, 1
       )`,
    ).run(mission.id, 'e'.repeat(64));
    const changed = vi.fn();
    const unsubscribe = store.onChange(changed);

    const blocked = store.transitionLifecycle(
      mission.id,
      {
        updatedAt: running.updatedAt,
        intentVersion: running.intentVersion!,
      },
      { status: 'blocked', intentState: 'blocked_technical' },
    );

    expect(blocked).toEqual(
      expect.objectContaining({
        status: 'blocked',
        intentState: 'blocked_technical',
        description: 'Keep this diagnosis',
        updatedAt: running.updatedAt + 1,
      }),
    );
    expect(changed).toHaveBeenCalledOnce();
    expect(
      db.prepare(
        'SELECT status, intent_state, description, updated_at FROM missions WHERE id = ?',
      ).get(mission.id),
    ).toEqual({
      status: 'blocked',
      intent_state: 'blocked_technical',
      description: 'Keep this diagnosis',
      updated_at: running.updatedAt + 1,
    });
    expect(
      db.prepare('SELECT status, updated_at FROM tasks WHERE id = ?').get(
        'task-lifecycle',
      ),
    ).toEqual({ status: 'failed', updated_at: running.updatedAt + 1 });
    expect(
      db.prepare(
        'SELECT state, last_error, updated_at FROM task_dispatch_queue WHERE id = ?',
      ).get('dispatch-lifecycle'),
    ).toEqual({
      state: 'superseded',
      last_error:
        'A missão foi bloqueada ou falhou; a autoridade deste worker foi revogada.',
      updated_at: running.updatedAt + 1,
    });
    unsubscribe();
  });

  it('keeps lifecycle fields out of content updates while legacy update remains available', () => {
    const runtimeManager = manager();
    const store = createScopedMissionStore(runtimeManager, testProjectScope(), {
      idFactory: () => 'mission-content-only',
    });
    const mission = store.create({ title: 'Original content' });
    const contract = compileIntentContract({
      goal: 'Update only durable mission content',
      intentVersion: 2,
    });

    expect(
      store.updateContent(mission.id, {
        title: 'Updated content',
        description: 'Content description',
        milestones: ['Content milestone'],
        intentContract: contract,
        intentVersion: 2,
      }),
    ).toMatchObject({
      title: 'Updated content',
      description: 'Content description',
      status: 'pending',
      intentState: 'legacy',
      intentVersion: 2,
      milestones: [
        {
          id: 'step-1',
          label: 'Content milestone',
          status: 'pending',
          evidenceIds: [],
        },
      ],
    });
    expect(() =>
      store.updateContent(mission.id, { status: 'running' } as never),
    ).toThrow(/Unrecognized key.*status/i);
    expect(() =>
      store.updateContent(mission.id, {
        intentState: 'executing',
      } as never),
    ).toThrow(/Unrecognized key.*intentState/i);

    expect(
      store.update(mission.id, {
        status: 'running',
        intentState: 'executing',
      }),
    ).toMatchObject({
      status: 'running',
      intentState: 'executing',
      title: 'Updated content',
    });
  });

  it('preserves explicit technical blocks and defaults only unspecified blocks to user', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'blocking-contract' });
    let sequence = 0;
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => `mission-block-${++sequence}`,
    });
    const technical = store.create({
      title: 'Falha recuperável',
      intentState: 'executing',
    });
    store.setStatus(technical.id, 'running');

    expect(
      store.update(technical.id, {
        status: 'blocked',
        intentState: 'blocked_technical',
      }),
    ).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    expect(
      store.update(technical.id, { description: 'Diagnóstico atualizado' }),
    ).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    expect(store.setStatus(technical.id, 'blocked')).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });

    const unspecified = store.create({
      title: 'Espera humana sem classificação',
      intentState: 'executing',
    });
    store.setStatus(unspecified.id, 'running');
    expect(store.setStatus(unspecified.id, 'blocked')).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
    });

    const canonical = store.create({
      title: 'Contrato técnico canônico',
      intentState: 'executing',
    });
    store.setStatus(canonical.id, 'running');
    expect(store.block(canonical.id, 'technical')).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.get(technical.id)).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    expect(reopened.get(unspecified.id)).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
    });
    expect(reopened.get(canonical.id)).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
  });

  it('persiste RouteReservation, consome uma vez e invalida expiração/intenção', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    let now = 1_000;
    let sequence = 0;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++sequence}`,
    });
    const mission = store.create({
      title: 'Rota durável',
      intentState: 'dispatched',
      intentVersion: 1,
    });
    store.setStatus(mission.id, 'running');
    const decision = {
      tier: 'medium' as const,
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      reason: 'modelo real do CLI para execução isolada',
      alternatives: [
        { adapterId: 'kimi', model: 'kimi-code/kimi-for-coding', effort: 'medium' },
      ],
    };
    const reserved = store.reserveRouteDecision(mission.id, 'implementar RC3', decision);
    expect(store.listOpenRouteAdapterIds(mission.id)).toEqual(['codex']);
    expect(reserved).toMatchObject({
      id: 'route-reservation-2',
      missionId: mission.id,
      intentVersion: 1,
      decision,
      createdAt: 1_000,
      expiresAt: 301_000,
    });
    expect(store.get(mission.id)?.latestRoute).toMatchObject({
      reservationId: reserved.id,
      taskPreview: 'implementar RC3',
      tier: 'medium',
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      reason: 'modelo real do CLI para execução isolada',
      state: 'reserved',
    });

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.getRouteReservation(reserved.id)).toMatchObject({
      id: reserved.id,
      decision,
    });
    const expectation = {
      reservationId: reserved.id,
      missionId: mission.id,
      adapterId: decision.adapterId,
      model: decision.model,
      effort: decision.effort,
      at: 1_001,
    };
    expect(reopened.assertRouteReservation(expectation).consumedAt).toBeUndefined();
    expect(
      reopened.consumeRouteReservation(expectation, 'orchestrator-session'),
    ).toMatchObject({
      consumedAt: 1_001,
      consumedBySession: 'orchestrator-session',
    });
    expect(reopened.listOpenRouteAdapterIds(mission.id)).toEqual([]);
    expect(reopened.list()[0]?.latestRoute).toMatchObject({
      reservationId: reserved.id,
      state: 'consumed',
      consumedBySession: 'orchestrator-session',
    });
    expect(() => reopened.consumeRouteReservation(expectation, 'other-session')).toThrow(
      /já foi consumida/i,
    );

    now = 2_000;
    const fresh = store.reserveRouteDecision(mission.id, 'outra tarefa', decision, 1_000);
    expect(() =>
      store.assertRouteReservation({
        ...expectation,
        reservationId: fresh.id,
        at: fresh.expiresAt,
      }),
    ).toThrow(/expirou/i);

    const stale = store.reserveRouteDecision(mission.id, 'intenção atual', decision);
    store.update(mission.id, { intentVersion: 2 });
    expect(() =>
      store.assertRouteReservation({
        ...expectation,
        reservationId: stale.id,
        at: now,
      }),
    ).toThrow(/intenção.*mudou/i);
  });

  it('vincula o squad selado da missão à reserva e recusa consumir após rebind (RC4)', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'route-reservation-squad-binding' });
    let now = 1_000;
    let sequence = 0;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++sequence}`,
    });
    const mission = store.create({
      title: 'Missão agêntica vinculada a squad',
      intentState: 'dispatched',
      intentVersion: 1,
      squadId: 'agentic-runtime-squad-a',
    });
    store.setStatus(mission.id, 'running');
    const decision = {
      tier: 'medium' as const,
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      reason: 'rota do membro do squad',
      alternatives: [],
    };

    // A reserva CARIMBA o squad selado da missão no instante da criação.
    const reservation = store.reserveRouteDecision(mission.id, 'implementar RC4', decision);
    expect(reservation.squadId).toBe('agentic-runtime-squad-a');

    const expectation = {
      reservationId: reservation.id,
      missionId: mission.id,
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      at: now + 1,
    };
    // Enquanto o squad da missão não muda, o gate aceita a reserva.
    expect(store.assertRouteReservation(expectation).squadId).toBe(
      'agentic-runtime-squad-a',
    );

    // Rebind da missão para OUTRO squad invalida a reserva antiga: o gate do
    // pane_spawn (que chama assertRouteReservation) não pode consumir uma rota
    // que não pertence ao squad atual da missão.
    runtimeManager
      .open(scope)
      .db.prepare('UPDATE missions SET squad_id = ? WHERE id = ?')
      .run('agentic-runtime-squad-b', mission.id);
    expect(() => store.assertRouteReservation(expectation)).toThrow(
      /route_reservation_squad_mismatch/,
    );
  });

  it('persiste aceite do kickoff e invalida sessão/revisão antigas após restart', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'kickoff-proof' });
    let now = 7_000;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => now,
      idFactory: () => 'mission-kickoff-proof',
    });
    const contract = {
      ...compileIntentContract({
        goal: 'Executar uma missão real com kickoff observado',
        intentVersion: 3,
      }),
      approvedAt: 6_000,
      dispatchedAt: 6_500,
    };
    const mission = store.create({
      title: 'Kickoff durável',
      intentState: 'dispatched',
      intentVersion: 3,
      intentContract: contract,
      orchestratorSessionId: 'orch-a',
    });
    store.setStatus(mission.id, 'running');

    expect(store.hasCurrentKickoffAcceptance(mission.id)).toBe(false);
    expect(
      store.recordKickoffAcceptance({
        missionId: mission.id,
        intentVersion: 3,
        orchestratorSessionId: 'orch-a',
        promptHash: 'a'.repeat(64),
      }),
    ).toMatchObject({
      missionId: mission.id,
      intentVersion: 3,
      orchestratorSessionId: 'orch-a',
      promptHash: 'a'.repeat(64),
      acceptedAt: 7_000,
    });
    expect(store.hasCurrentKickoffAcceptance(mission.id)).toBe(true);
    expect(
      store.hasExactCurrentKickoffAcceptance({
        missionId: mission.id,
        intentVersion: 3,
        orchestratorSessionId: 'orch-a',
        promptHash: 'a'.repeat(64),
      }),
    ).toBe(true);
    expect(
      store.hasExactCurrentKickoffAcceptance({
        missionId: mission.id,
        intentVersion: 3,
        orchestratorSessionId: 'orch-a',
        promptHash: 'b'.repeat(64),
      }),
    ).toBe(false);

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope, {
      now: () => now,
    });
    expect(reopened.hasCurrentKickoffAcceptance(mission.id)).toBe(true);

    reopened.setOrchestratorSession(mission.id, 'orch-b');
    expect(reopened.hasCurrentKickoffAcceptance(mission.id)).toBe(false);
    expect(
      reopened.hasExactCurrentKickoffAcceptance({
        missionId: mission.id,
        intentVersion: 3,
        orchestratorSessionId: 'orch-a',
        promptHash: 'a'.repeat(64),
      }),
    ).toBe(false);
    expect(() =>
      reopened.recordKickoffAcceptance({
        missionId: mission.id,
        intentVersion: 3,
        orchestratorSessionId: 'orch-a',
        promptHash: 'a'.repeat(64),
      }),
    ).toThrow(/autoridade.*kickoff/i);

    now = 8_000;
    reopened.recordKickoffAcceptance({
      missionId: mission.id,
      intentVersion: 3,
      orchestratorSessionId: 'orch-b',
      promptHash: 'b'.repeat(64),
    });
    expect(reopened.hasCurrentKickoffAcceptance(mission.id)).toBe(true);

    reopened.update(mission.id, {
      intentVersion: 4,
      intentContract: {
        ...contract,
        intentVersion: 4,
        approvedAt: 7_500,
        dispatchedAt: 7_600,
      },
    });
    expect(reopened.hasCurrentKickoffAcceptance(mission.id)).toBe(false);
  });
  it('records a sealed pre-CAS kickoff receipt without granting dispatch authority', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'kickoff-proof-pre-cas' });
    let sequence = 0;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => 9_000,
      idFactory: () => `mission-kickoff-pre-cas-${++sequence}`,
    });
    const approvedContract = {
      ...compileIntentContract({
        goal: 'Commit receipt before lifecycle promotion',
        intentVersion: 2,
      }),
      approvedAt: 8_000,
      approvalReviewSha256: 'c'.repeat(64),
      dispatchedAt: 8_500,
    };
    const mission = store.create({
      title: 'Kickoff pre-CAS',
      intentState: 'ready_to_start',
      intentVersion: 2,
      intentContract: approvedContract,
      orchestratorSessionId: 'orch-current',
    });
    const unsealed = store.create({
      title: 'Kickoff sem review seal',
      intentState: 'ready_to_start',
      intentVersion: 2,
      intentContract: {
        ...approvedContract,
        approvalReviewSha256: undefined,
      },
      orchestratorSessionId: 'orch-unsealed',
    });

    expect(mission.status).toBe('pending');
    expect(() =>
      store.recordKickoffAcceptance({
        missionId: mission.id,
        intentVersion: 2,
        orchestratorSessionId: 'orch-stale',
        promptHash: 'd'.repeat(64),
      }),
    ).toThrow(/autoridade.*kickoff/i);
    expect(() =>
      store.recordKickoffAcceptance({
        missionId: mission.id,
        intentVersion: 1,
        orchestratorSessionId: 'orch-current',
        promptHash: 'd'.repeat(64),
      }),
    ).toThrow(/autoridade.*kickoff/i);
    expect(() =>
      store.recordKickoffAcceptance({
        missionId: unsealed.id,
        intentVersion: 2,
        orchestratorSessionId: 'orch-unsealed',
        promptHash: 'e'.repeat(64),
      }),
    ).toThrow(/autoridade.*kickoff/i);

    store.recordKickoffAcceptance({
      missionId: mission.id,
      intentVersion: 2,
      orchestratorSessionId: 'orch-current',
      promptHash: 'f'.repeat(64),
    });
    expect(store.hasCurrentKickoffAcceptance(mission.id)).toBe(true);
    expect(hasCurrentDispatchAuthority(store.get(mission.id)!)).toBe(false);

    store.update(mission.id, {
      intentVersion: 3,
      intentContract: {
        ...approvedContract,
        intentVersion: 3,
        approvedAt: 8_500,
        approvalReviewSha256: 'a'.repeat(64),
      },
    });
    expect(store.hasCurrentKickoffAcceptance(mission.id)).toBe(false);
  });


  it('bloqueia atomicamente a saída física do Maestro antes do primeiro dispatch', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'orchestrator-exit' });
    let now = 9_000;
    let sequence = 0;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++sequence}`,
    });
    const createRunningMission = (
      sessionId: string,
      title: string,
      kickoffAccepted = true,
    ) => {
      const contract = {
        ...compileIntentContract({
          goal: `Entregar ${title} com delegação física`,
          intentVersion: 1,
        }),
        approvedAt: 8_000,
        dispatchedAt: 8_500,
        squadRevisionHash: 'a'.repeat(64),
      };
      const created = store.create({
        title,
        intentState: 'dispatched',
        intentVersion: 1,
        intentContract: contract,
        orchestratorSessionId: sessionId,
      });
      store.setStatus(created.id, 'running');
      if (kickoffAccepted) {
        store.recordKickoffAcceptance({
          missionId: created.id,
          intentVersion: 1,
          orchestratorSessionId: sessionId,
          promptHash: 'b'.repeat(64),
        });
      }
      return created;
    };
    const exitInput = (
      target: ReturnType<typeof createRunningMission>,
      orchestratorSessionId: string,
      outputTail: string,
      observation:
        | 'physical_exit'
        | 'missing_session_reconcile' = 'physical_exit',
    ) => {
      const current = store.get(target.id)!;
      return {
        missionId: target.id,
        orchestratorSessionId,
        intentVersion: current.intentVersion!,
        intentContractHash: hashMissionIntentAuthority(
          current.intentContract!,
        ),
        squadRevisionHash: current.intentContract!.squadRevisionHash!,
        observation,
        outputTail,
      };
    };

    const mission = createRunningMission('orch-exited', 'Missão interrompida');
    store.ensureDriveRuntimeState(mission.id, 8_900);
    now = 9_100;
    expect(
      store.blockOrchestratorPreDispatchExit({
        ...exitInput(mission, 'orch-exited', 'autoridade obsoleta'),
        intentContractHash: 'f'.repeat(64),
      }),
    ).toBeNull();
    expect(store.get(mission.id)?.status).toBe('running');

    const blocked = store.blockOrchestratorPreDispatchExit(
      exitInput(
        mission,
        'orch-exited',
        'Planejando delegação\npassword=nao-persistir\núltima linha segura',
      ),
    );

    expect(blocked).toMatchObject({
      id: mission.id,
      status: 'blocked',
      intentState: 'blocked_technical',
      orchestratorSessionId: 'orch-exited',
    });
    expect(blocked?.description).toContain(
      MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_MARKER,
    );
    expect(blocked?.description).toContain(
      MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_REASON,
    );
    expect(store.getDriveRuntimeState(mission.id)).toMatchObject({
      lastActionKind: 'orchestrator_exit',
      lastOutcome: 'failed',
      lastError: MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_REASON,
    });

    const db = runtimeManager.open(scope).db;
    const event = db
      .prepare(
        `SELECT event_type, payload_json, origin
           FROM mission_events
          WHERE mission_id = ?`,
      )
      .get(mission.id) as {
      event_type: string;
      payload_json: string;
      origin: string;
    };
    expect(event).toMatchObject({
      event_type: 'agent.finished',
      origin: 'system',
    });
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: 'orchestrator.pre_dispatch_exit',
      reason: MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_REASON,
      sessionId: 'orch-exited',
      intentVersion: 1,
      phase: 'before_first_dispatch',
    });
    expect(payload.outputTail).toContain('última linha segura');
    expect(payload.outputTail).not.toContain('nao-persistir');

    const race = createRunningMission(
      'orch-intentional-race',
      'Missão com teardown intencional',
    );
    const raceBlocked = store.blockOrchestratorPreDispatchExit(
      exitInput(
        race,
        'orch-intentional-race',
        'exit publicado durante close intencional',
      ),
    );
    expect(raceBlocked).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    const raceCurrent = store.get(race.id)!;
    const raceSeal = {
      intentVersion: 1,
      intentContractHash: hashMissionIntentAuthority(
        raceCurrent.intentContract!,
      ),
      contextRevision: 'd'.repeat(64),
      contractHash: 'e'.repeat(64),
      squadRevisionHash: raceCurrent.intentContract!.squadRevisionHash!,
    };
    const exactRaceExit = db.prepare(
      `SELECT payload_json
         FROM mission_events
        WHERE mission_id = ?
          AND event_type = 'agent.finished'`,
    ).get(race.id) as { payload_json: string };
    expect(JSON.parse(exactRaceExit.payload_json)).toMatchObject({
      event: 'orchestrator.pre_dispatch_exit',
      sessionId: 'orch-intentional-race',
      intentVersion: 1,
    });
    expect(hashMissionIntentAuthority(raceCurrent.intentContract!)).toBe(
      raceSeal.intentContractHash,
    );
    expect(
      store.retireOrchestratorSessionForReplacement(
        race.id,
        'orch-intentional-race',
        raceSeal,
      ),
    ).toMatchObject({
      status: 'running',
      intentState: 'executing',
      orchestratorSessionId: undefined,
    });
    expect(store.get(race.id)?.description).not.toContain(
      MISSION_ORCHESTRATOR_PRE_DISPATCH_EXIT_MARKER,
    );

    const operatorBlocked = createRunningMission(
      'orch-operator-block',
      'Missão interrompida pelo operador',
    );
    store.blockOrchestratorPreDispatchExit(
      exitInput(
        operatorBlocked,
        'orch-operator-block',
        'exit anterior ao bloqueio humano',
      ),
    );
    store.update(operatorBlocked.id, {
      status: 'blocked',
      intentState: 'blocked_user',
    });
    const operatorCurrent = store.get(operatorBlocked.id)!;
    expect(
      store.retireOrchestratorSessionForReplacement(
        operatorBlocked.id,
        'orch-operator-block',
        {
          ...raceSeal,
          intentContractHash: hashMissionIntentAuthority(
            operatorCurrent.intentContract!,
          ),
          squadRevisionHash:
            operatorCurrent.intentContract!.squadRevisionHash!,
        },
      ),
    ).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
      orchestratorSessionId: undefined,
    });

    expect(
      store.blockOrchestratorPreDispatchExit(
        exitInput(mission, 'orch-exited', 'evento repetido'),
      ),
    ).toBeNull();
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS value FROM mission_events WHERE mission_id = ?',
        )
        .get(mission.id),
    ).toEqual({ value: 1 });

    // "Retomar missão" rearma a mesma revisão como running/executing antes
    // do replacement Maestro. Uma segunda saída ainda sem dispatch deve
    // bloquear de novo, sem depender do antigo estado `dispatched`.
    store.setOrchestratorSession(mission.id, null);
    store.update(mission.id, {
      status: 'running',
      intentState: 'executing',
    });
    store.setOrchestratorSession(mission.id, 'orch-retry');
    const rearmed = store.get(mission.id)!;
    expect(
      store.blockOrchestratorPreDispatchExit(
        exitInput(rearmed, 'orch-retry', 'replacement também encerrou'),
      ),
    ).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
      orchestratorSessionId: 'orch-retry',
    });
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS value FROM mission_events WHERE mission_id = ?',
        )
        .get(mission.id),
    ).toEqual({ value: 2 });

    const alreadyDispatched = createRunningMission(
      'orch-with-dispatch',
      'Missão já delegada',
    );
    db.prepare(
      `INSERT INTO tasks
         (id, mission_id, title, detail, status, priority, created_at, updated_at)
       VALUES ('task-already-dispatched', ?, 'Worker', '', 'running', 0, 1, 1)`,
    ).run(alreadyDispatched.id);
    db.prepare(
      `INSERT INTO task_dispatch_queue
         (id, task_id, mission_id, intent_version, state,
          lease_token_hash, lease_owner, lease_expires_at, worker_id,
          created_at, updated_at)
       VALUES (
         'dispatch-already-created', 'task-already-dispatched', ?, 1, 'claimed',
         ?, 'main', 99_000, 'worker-a', 1, 1
       )`,
    ).run(alreadyDispatched.id, 'c'.repeat(64));
    expect(
      store.blockOrchestratorPreDispatchExit(
        exitInput(
          alreadyDispatched,
          'orch-with-dispatch',
          'Maestro encerrou após delegar',
        ),
      ),
    ).toBeNull();
    expect(store.get(alreadyDispatched.id)).toMatchObject({
      status: 'running',
      intentState: 'dispatched',
    });

    const exitedDuringKickoff = createRunningMission(
      'orch-during-kickoff',
      'Missão sem recibo ainda',
      false,
    );
    expect(
      store.blockOrchestratorPreDispatchExit(
        exitInput(
          exitedDuringKickoff,
          'orch-during-kickoff',
          'CLI encerrou durante o kickoff',
        ),
      ),
    ).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.get(mission.id)).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
  });

  it('notifies only observers bound to the mutated scope', () => {
    const runtimeManager = manager();
    const scopeA = testProjectScope({ checkoutId: 'checkout-a' });
    const scopeB = testProjectScope({ checkoutId: 'checkout-b' });
    const storeA = createScopedMissionStore(runtimeManager, scopeA);
    const storeB = createScopedMissionStore(runtimeManager, scopeB);
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    storeA.onChange(listenerA);
    storeB.onChange(listenerB);

    storeA.create({ title: 'A' });

    expect(listenerA).toHaveBeenCalledWith({
      projectId: scopeA.projectId,
      checkoutId: scopeA.checkoutId,
    });
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('fails closed when the runtime is unavailable instead of retaining memory data', () => {
    const unavailable = new ProjectRuntimeManager({
      baseDir,
      appVersion: '0.12.0-test',
      databaseFactory: (() => {
        throw new Error('native database unavailable');
      }) as never,
    });
    managers.push(unavailable);
    const store = createScopedMissionStore(unavailable, testProjectScope());

    expect(() => store.list()).toThrow(/no persistence fallback/i);
    expect(() => store.create({ title: 'must not exist' })).toThrow(
      /no persistence fallback/i,
    );
  });

  it('allows inspection but rejects writes in engine-enforced safe read-only mode', () => {
    const scope = testProjectScope({ checkoutId: 'read-only' });
    const writableManager = manager();
    createScopedMissionStore(writableManager, scope, {
      idFactory: () => 'mission-read-only',
    }).create({ title: 'Persisted before failure' });
    writableManager.closeAll();

    const original = INITIAL_PROJECT_MIGRATIONS[0];
    const changed = createProjectMigration({
      id: original.id,
      schemaVersion: original.schemaVersion,
      appVersion: original.appVersion,
      sql: `${original.sql}\n-- immutable checksum changed`,
    });
    const safeReadOnlyManager = new ProjectRuntimeManager({
      baseDir,
      appVersion: '0.12.0-test',
      migrations: [changed],
    });
    managers.push(safeReadOnlyManager);
    const store = createScopedMissionStore(safeReadOnlyManager, scope);

    expect(store.list()).toHaveLength(1);
    expect(safeReadOnlyManager.open(scope).mode).toBe('safe-read-only');
    expect(() => store.create({ title: 'forbidden' })).toThrow(/read-only/i);
    expect(() => store.update('missing', {})).toThrow(/read-only/i);
    expect(store.list()).toHaveLength(1);
  });

  it('learnings começa vazio; appendLearning anexa com separador e persiste', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-learn',
    });
    const created = store.create({ title: 'Aprender' });
    expect(created.learnings).toBe('');

    const first = store.appendLearning(
      'mission-learn',
      '## Padrões\n- use X para Y',
    );
    expect(first?.learnings).toBe('## Padrões\n- use X para Y');

    // Segunda entrada ganha separador de parágrafo (não cola na anterior).
    const second = store.appendLearning(
      'mission-learn',
      '## Entrada\n- descobri Z',
    );
    expect(second?.learnings).toBe(
      '## Padrões\n- use X para Y\n\n## Entrada\n- descobri Z',
    );

    // Persiste após reabrir o runtime (provou que foi ao DB, não só memória).
    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.get('mission-learn')?.learnings).toBe(
      '## Padrões\n- use X para Y\n\n## Entrada\n- descobri Z',
    );
  });

  it('appendLearning retorna null para missão inexistente', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedMissionStore(runtimeManager, scope);
    expect(store.appendLearning('nope', 'entry')).toBeNull();
  });

  it('coerces legacy string[] milestones to structured on create and reload', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-legacy',
    });
    const created = store.create({
      title: 'Legacy',
      milestones: ['design', 'build', 'ship'],
    });
    expect(created.milestones).toEqual([
      { id: 'step-1', label: 'design', status: 'pending', evidenceIds: [] },
      { id: 'step-2', label: 'build', status: 'pending', evidenceIds: [] },
      { id: 'step-3', label: 'ship', status: 'pending', evidenceIds: [] },
    ]);
    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.get('mission-legacy')?.milestones).toEqual(created.milestones);
  });

  it('persists structured milestones round-trip and rejects done without evidence', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-struct',
    });
    store.create({
      title: 'Structured',
      milestones: [
        {
          id: 's1',
          label: 'Scaffold',
          status: 'in-progress',
          evidenceIds: [],
        },
        {
          id: 's2',
          label: 'Ship',
          status: 'pending',
          evidenceIds: [],
        },
      ],
    });
    // Attempt to mark done without evidenceIds → structural coerce to pending.
    const coerced = store.update('mission-struct', {
      milestones: [
        {
          id: 's1',
          label: 'Scaffold',
          status: 'done',
          evidenceIds: [],
        },
        {
          id: 's2',
          label: 'Ship',
          status: 'pending',
          evidenceIds: [],
        },
      ],
    });
    expect(coerced?.milestones[0]?.status).toBe('pending');
    expect(coerced?.milestones[0]?.evidenceIds).toEqual([]);

    // With evidenceIds present, update stores the claim; markMilestoneDone
    // still requires those ids to be in the trusted set.
    store.update('mission-struct', {
      milestones: [
        {
          id: 's1',
          label: 'Scaffold',
          status: 'in-progress',
          evidenceIds: ['ev-1'],
        },
        {
          id: 's2',
          label: 'Ship',
          status: 'pending',
          evidenceIds: [],
        },
      ],
    });
    const untrusted = store.markMilestoneDone('mission-struct', 's1', []);
    expect(untrusted?.milestones.find((s) => s.id === 's1')?.status).toBe(
      'in-progress',
    );
    const trusted = store.markMilestoneDone('mission-struct', 's1', ['ev-1']);
    expect(trusted?.milestones.find((s) => s.id === 's1')?.status).toBe('done');

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.get('mission-struct')?.milestones).toEqual([
      {
        id: 's1',
        label: 'Scaffold',
        status: 'done',
        evidenceIds: ['ev-1'],
      },
      {
        id: 's2',
        label: 'Ship',
        status: 'pending',
        evidenceIds: [],
      },
    ]);
  });

  it('loads mixed legacy string + structured rows from milestones_json', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-mixed',
    });
    // Write raw mixed JSON the way an older client + new client might leave it.
    const created = store.create({ title: 'Mixed' });
    const db = runtimeManager.open(scope).db;
    db.prepare(
      'UPDATE missions SET milestones_json = ? WHERE id = ?',
    ).run(
      JSON.stringify([
        'legacy-label',
        {
          id: 'custom',
          label: 'Structured step',
          status: 'blocked',
          evidenceIds: ['e1'],
        },
      ]),
      created.id,
    );
    const loaded = store.get('mission-mixed');
    expect(loaded?.milestones).toEqual([
      {
        id: 'step-1',
        label: 'legacy-label',
        status: 'pending',
        evidenceIds: [],
      },
      {
        id: 'custom',
        label: 'Structured step',
        status: 'blocked',
        evidenceIds: ['e1'],
      },
    ]);
  });

  // REGRESSÃO: uma missão entregou 8/8 handoffs, todos os dispatches
  // completed e worktrees integrated, e mesmo assim ficou eterna em `running`.
  // O gate de release morreu por timeout e o post-mortem no banco não tinha o
  // que ler: o motivo do `wait` do driver e o not-ready do autopilot só
  // existiam em memória. Estas colunas são o que transforma "travou" em
  // "travou por X".
  it('persiste o motivo da parada por camada, sem consumir orçamento de tentativa', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'stall-diag' });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-stall',
    });
    store.create({ title: 'Missão que não sela' });
    const initial = store.ensureDriveRuntimeState('mission-stall', 100);

    expect(
      store.recordDriveStallReason(
        'mission-stall',
        'driver-wait',
        'mission is running',
        200,
      ),
    ).toBe(true);
    expect(
      store.recordDriveStallReason(
        'mission-stall',
        'autopilot',
        'plano selado ainda não terminal',
        210,
      ),
    ).toBe(true);

    const diagnosed = store.getDriveRuntimeState('mission-stall')!;
    expect(diagnosed).toMatchObject({
      lastWaitReason: 'mission is running',
      lastWaitReasonAt: 200,
      lastAutopilotReason: 'plano selado ainda não terminal',
      lastAutopilotReasonAt: 210,
    });
    // Parar não é tentativa: nada de orçamento, revisão ou falso progresso.
    expect(diagnosed.attemptCount).toBe(initial.attemptCount);
    expect(diagnosed.revision).toBe(initial.revision);
    expect(diagnosed.updatedAt).toBe(initial.updatedAt);
    expect(diagnosed.lastActionKind).toBeUndefined();

    // A 5s por tick, repetir o mesmo motivo não pode reescrever a linha.
    expect(
      store.recordDriveStallReason(
        'mission-stall',
        'driver-wait',
        'mission is running',
        300,
      ),
    ).toBe(false);
    expect(store.getDriveRuntimeState('mission-stall')).toMatchObject({
      lastWaitReasonAt: 200,
    });

    // Só a transição de motivo grava — e carimba o instante dela.
    expect(
      store.recordDriveStallReason(
        'mission-stall',
        'driver-wait',
        'trusted evidence missing for current step',
        400,
      ),
    ).toBe(true);
    expect(store.getDriveRuntimeState('mission-stall')).toMatchObject({
      lastWaitReason: 'trusted evidence missing for current step',
      lastWaitReasonAt: 400,
      lastAutopilotReason: 'plano selado ainda não terminal',
    });
  });

  it('persists Ralph budget, failed attempts and signal debounce across restart', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'ralph-runtime' });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-ralph',
    });
    store.create({ title: 'Durable loop' });

    expect(store.ensureDriveRuntimeState('mission-ralph', 100)).toMatchObject({
      runStartedAt: 100,
      attemptCount: 0,
    });
    expect(
      store.reserveDriveAttempt('mission-ralph', 'signal-stall', 200),
    ).toMatchObject({
      attemptCount: 1,
      lastAttemptAt: 200,
      lastOutcome: 'reserved',
    });
    expect(
      store.finishDriveAttempt(
        'mission-ralph',
        'failed',
        250,
        'delivery failed',
      ),
    ).toMatchObject({
      attemptCount: 1,
      lastOutcome: 'failed',
      lastError: 'delivery failed',
    });
    store.recordDriveSignal('mission-ralph', 275);

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    expect(reopened.getDriveRuntimeState('mission-ralph')).toMatchObject({
      runStartedAt: 100,
      attemptCount: 1,
      lastAttemptAt: 200,
      lastSignalAt: 275,
      lastOutcome: 'failed',
    });
    expect(
      reopened.reserveDriveAttempt('mission-ralph', 'advance', 300),
    ).toMatchObject({
      runStartedAt: 100,
      attemptCount: 2,
      lastAttemptAt: 300,
    });
    reopened.setStatus('mission-ralph', 'blocked');
    reopened.setStatus('mission-ralph', 'running');
    expect(reopened.getDriveRuntimeState('mission-ralph')).toBeNull();
  });

  it('write status-only de reativação nunca deixa intent de bloqueio (split-brain mata a autoridade de dispatch)', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'split-brain-guard' });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-split',
    });
    store.create({
      title: 'Split brain',
      orchestratorSessionId: 'session-1',
    });
    // Bloqueio técnico legítimo (os dois campos juntos).
    store.update('mission-split', {
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    expect(store.get('mission-split')).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });

    // Reativação por write status-only — o caminho exato do
    // nexus_mission_set_status / delegation-supervisor / resume parcial.
    store.setStatus('mission-split', 'running');

    // A missão viva herda intent executável (semântica do Retomar), não o
    // cadáver blocked_technical que mata canDispatchWorkers e faz o
    // terminator de 1s assassinar qualquer runtime respawnado.
    expect(store.get('mission-split')).toMatchObject({
      status: 'running',
      intentState: 'executing',
    });
  });

  it('updated_at é estritamente monotônico mesmo com duas escritas no mesmo milissegundo (B2)', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'updated-at-monotonic' });
    const store = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-monotonic',
      now: () => 1_000,
    });
    store.create({ title: 'Monotonic', orchestratorSessionId: 'session-1' });

    // transitionLifecycle grava 1_001 (guarda monotônica).
    const transitioned = store.transitionLifecycle(
      'mission-monotonic',
      { updatedAt: 1_000, intentVersion: 0 },
      { status: 'running', intentState: 'executing' },
    );
    expect(transitioned?.updatedAt).toBe(1_001);

    // update()/block() no MESMO milissegundo não pode regredir para 1_000.
    const blocked = store.block('mission-monotonic', 'technical');
    expect(blocked?.updatedAt).toBeGreaterThanOrEqual(1_001);

    // E a sequência continua avançando mesmo com o relógio parado.
    const resumed = store.transitionLifecycle(
      'mission-monotonic',
      { updatedAt: blocked!.updatedAt, intentVersion: 0 },
      { status: 'running', intentState: 'executing' },
    );
    expect(resumed?.updatedAt).toBeGreaterThan(blocked!.updatedAt);
  });

  it('persistLeftoverIsolation park grava blocked e não deixa running', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'leftover-park' });
    let now = 100;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => ++now,
      idFactory: () => 'mission-leftover-park',
    });
    const created = store.create({
      title: 'Leftover na rail',
      description: 'Time de 20 stories',
    });
    store.setStatus(created.id, 'running');
    expect(store.get(created.id)?.status).toBe('running');

    const parked = store.persistLeftoverIsolation(created.id, 'park');
    expect(parked?.status).toBe('blocked');
    expect(parked?.intentState).toBe('blocked_user');
    expect(parked?.description).toContain('<!-- nexus:leftover-parked -->');
    expect(store.list('running')).toEqual([]);
    expect(store.get(created.id)?.status).toBe('blocked');
  });

  it('Encerrar persiste leftover blocked no SQLite e reopen não vê running', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ checkoutId: 'leftover-encerrar' });
    let now = 200;
    const store = createScopedMissionStore(runtimeManager, scope, {
      now: () => ++now,
      idFactory: () => 'mission-ebd1c3ee',
    });
    const created = store.create({
      title: 'stress-tiny',
      description: 'Via Rápida mid-flight',
    });
    store.setStatus(created.id, 'running');
    expect(store.get(created.id)?.status).toBe('running');

    const parked = store.persistLeftoverIsolation(created.id, 'encerrar');
    expect(parked?.status).toBe('blocked');
    expect(parked?.intentState).toBe('blocked_user');
    expect(parked?.description).toContain('<!-- nexus:leftover-parked -->');
    expect(parked?.description).toContain('<!-- nexus:runtime-closed -->');
    expect(store.list('running')).toEqual([]);

    runtimeManager.close(scope);
    const reopened = createScopedMissionStore(runtimeManager, scope);
    const row = reopened.get(created.id);
    expect(row?.status).toBe('blocked');
    expect(row?.status).not.toBe('running');
    expect(row?.intentState).toBe('blocked_user');
    expect(row?.description).toContain('<!-- nexus:leftover-parked -->');
    expect(row?.description).toContain('<!-- nexus:runtime-closed -->');
    expect(reopened.list('running')).toEqual([]);
  });
});
