import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  compileIntentContract,
  hasCurrentDispatchAuthority,
} from '../../shared/mission-intent';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionStore } from './mission-store';
import { createScopedTaskStore } from './task-store';
import { createTaskDispatchStore } from './task-dispatch-store';
import { createScopedHandoffStore } from './handoff-store';
import { encodeTaskScheduleDetail } from './mission-scheduler-meta';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function approvedIntentContract(
  input: Parameters<typeof compileIntentContract>[0],
): ReturnType<typeof compileIntentContract> {
  return {
    ...compileIntentContract(input),
    approvedAt: 1,
    dispatchedAt: 1,
  };
}

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({ baseDir, appVersion: '0.19.27-test' });
  managers.push(value);
  return value;
}

function mergingDispatchFixture() {
  const runtime = manager();
  const scope = testProjectScope();
  const missions = createScopedMissionStore(runtime, scope);
  const tasks = createScopedTaskStore(runtime, scope);
  const handoffs = createScopedHandoffStore(runtime, scope);
  const dispatches = createTaskDispatchStore(runtime, scope);
  const contract = approvedIntentContract({
    goal: 'Projetar falha terminal de merge',
    intentVersion: 1,
  });
  const mission = missions.create({
    title: 'Merge terminal',
    intentVersion: 1,
    intentState: 'executing',
    intentContract: contract,
  });
  missions.setStatus(mission.id, 'running');
  const task = tasks.create({
    missionId: mission.id,
    title: 'Integrar candidato',
  });
  const route = missions.reserveRouteDecision(mission.id, task.title, {
    tier: 'hard',
    adapterId: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    reason: 'rota selada para o merge terminal',
    alternatives: [],
  });
  const claim = dispatches.claim({
    missionId: mission.id,
    taskId: task.id,
    intentVersion: 1,
    workerId: 'worker-merge-terminal',
    leaseOwner: 'main',
    leaseMs: 30_000,
    executionMode: 'isolated_worktree',
  });
  const routed = dispatches.attachRoute({
    taskId: task.id,
    revision: claim.revision,
    leaseToken: claim.leaseToken,
    routeReservationId: route.id,
    adapterId: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  });
  dispatches.bindSpawn({
    taskId: task.id,
    revision: routed.revision,
    leaseToken: claim.leaseToken,
    workerIncarnationId: claim.workerIncarnationId,
    paneId: 'pane-merge-terminal',
    sessionId: 'session-merge-terminal',
  });
  const handoff = handoffs.submit({
    missionId: mission.id,
    sessionId: 'session-merge-terminal',
    workerIncarnationId: claim.workerIncarnationId,
    fromAgent: 'worker-merge-terminal',
    status: 'success',
    summary: 'Candidato entregue com commit local para validação do coordenador.',
  });
  const ready = dispatches.acceptHandoff({
    sessionId: 'session-merge-terminal',
    workerIncarnationId: claim.workerIncarnationId,
    handoffId: handoff.id,
  });
  const merging = dispatches.beginMerge({
    taskId: task.id,
    revision: ready.revision,
  });
  return { runtime, scope, missions, tasks, dispatches, mission, task, merging };
}

function claimedDispatchFixture() {
  const runtime = manager();
  const scope = testProjectScope();
  const missions = createScopedMissionStore(runtime, scope);
  const tasks = createScopedTaskStore(runtime, scope);
  const dispatches = createTaskDispatchStore(runtime, scope);
  const contract = approvedIntentContract({
    goal: 'Recuperar reserva interrompida de worktree',
    intentVersion: 1,
  });
  const mission = missions.create({
    title: 'Reserva interrompida',
    intentVersion: 1,
    intentState: 'executing',
    intentContract: contract,
  });
  missions.setStatus(mission.id, 'running');
  const task = tasks.create({
    missionId: mission.id,
    title: 'Materializar worktree',
  });
  const claim = dispatches.claim({
    missionId: mission.id,
    taskId: task.id,
    intentVersion: 1,
    workerId: 'worker-reserved-crash',
    leaseOwner: 'main',
    leaseMs: 30_000,
    executionMode: 'isolated_worktree',
  });
  return { missions, tasks, dispatches, mission, task, claim };
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-task-dispatch-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('durable task dispatcher authority', () => {
  it('projects a failed interrupted worktree reservation immediately with one PT-BR CTA', () => {
    const { missions, tasks, dispatches, mission, task, claim } =
      claimedDispatchFixture();

    const blocked = dispatches.blockWorktreeCreationFailureByCoordinator({
      taskId: task.id,
      revision: claim.revision,
      reason:
        'A reserva persistiu, mas o worktree materializado não provou identidade exata após restart.',
    });

    expect(blocked).toMatchObject({
      state: 'blocked',
      integrationReceipt: undefined,
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('failed');
    const blockedMission = missions.get(mission.id)!;
    expect(blockedMission.status).toBe('blocked');
    expect(blockedMission.description.match(
      /NEXUS_TASK_DISPATCH_BLOCKED/g,
    )).toHaveLength(1);
    expect(blockedMission.description.match(
      /Clique em “Retomar missão”/g,
    )).toHaveLength(1);
  });

  it('projects a terminal runtime merge failure to dispatch, task and one PT-BR CTA', () => {
    const { missions, tasks, dispatches, mission, task, merging } =
      mergingDispatchFixture();

    const blocked = dispatches.blockMergeFailureByCoordinator({
      taskId: task.id,
      revision: merging.revision,
      reason:
        'A validação obrigatória do merge não foi executada; nenhuma integração foi aceita.',
    });

    expect(blocked).toMatchObject({
      state: 'blocked',
      integrationReceipt: undefined,
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('failed');
    const blockedMission = missions.get(mission.id)!;
    expect(blockedMission.status).toBe('blocked');
    expect(blockedMission.description.match(
      /NEXUS_TASK_DISPATCH_BLOCKED/g,
    )).toHaveLength(1);
    expect(blockedMission.description.match(
      /Clique em “Retomar missão”/g,
    )).toHaveLength(1);
  });

  it('projects an interrupted merge after restart idempotently without minting a receipt', () => {
    const { runtime, scope, mission, task, merging } =
      mergingDispatchFixture();
    runtime.close(scope);
    const restartedMissions = createScopedMissionStore(runtime, scope);
    const restartedTasks = createScopedTaskStore(runtime, scope);
    const restartedDispatches = createTaskDispatchStore(runtime, scope);

    const blocked = restartedDispatches.blockMergeFailureByCoordinator({
      taskId: task.id,
      revision: merging.revision,
      reason:
        'O Nexus reiniciou durante o merge; a integração exige revisão explícita.',
    });
    const replay = restartedDispatches.blockMergeFailureByCoordinator({
      taskId: task.id,
      revision: blocked.revision,
      reason: 'replay de reconciliação após restart',
    });

    expect(replay).toMatchObject({
      state: 'blocked',
      integrationReceipt: undefined,
    });
    expect(restartedTasks.list(mission.id)[0]?.status).toBe('failed');
    expect(restartedMissions.get(mission.id)).toMatchObject({
      status: 'blocked',
    });
    expect(restartedMissions.get(mission.id)?.description.match(
      /NEXUS_TASK_DISPATCH_BLOCKED/g,
    )).toHaveLength(1);
    expect(restartedMissions.get(mission.id)?.description.match(
      /Clique em “Retomar missão”/g,
    )).toHaveLength(1);
  });

  it('claims task + marks running atomically and fences a second dispatcher', () => {
    const runtime = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtime, scope, { now: () => 1_000 });
    const tasks = createScopedTaskStore(runtime, scope, { now: () => 1_000 });
    let id = 0;
    const dispatches = createTaskDispatchStore(runtime, scope, {
      now: () => 1_000,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({ goal: 'Corrigir auth', intentVersion: 1 });
    const mission = missions.create({
      title: 'Auth', intentVersion: 1, intentState: 'dispatched', intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Implementar fix' });

    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: `nexus-scheduler-${task.id}`,
      leaseOwner: 'main-coordinator',
      leaseMs: 30_000,
    });

    expect(claim).toMatchObject({
      taskId: task.id,
      missionId: mission.id,
      state: 'claimed',
      attempt: 1,
      revision: 1,
      workerIncarnationId: expect.stringMatching(/^worker-incarnation-/),
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('running');
    expect(() => dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: `nexus-scheduler-${task.id}`,
      leaseOwner: 'other-loop',
      leaseMs: 30_000,
    })).toThrow(/já (?:foi )?reservad|dispatch ativo/i);
  });

  it('persists route/spawn identity and rejects a stale fencing token', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let now = 2_000;
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope, { now: () => now });
    const tasks = createScopedTaskStore(runtime, scope, { now: () => now });
    const dispatches = createTaskDispatchStore(runtime, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({ goal: 'Adicionar teste', intentVersion: 3 });
    const mission = missions.create({
      title: 'Teste', intentVersion: 3, intentState: 'dispatched', intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Teste de regressão' });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'hard', adapterId: 'codex', model: 'gpt-5.6-sol', effort: 'high',
      reason: 'rota autoritativa para o dispatcher durável', alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 3,
      workerId: 'worker-stable',
      leaseOwner: 'main',
      leaseMs: 30_000,
    });

    expect(() => dispatches.attachRoute({
      taskId: task.id,
      revision: claim.revision,
      leaseToken: 'stale-token',
      routeReservationId: route.id,
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    })).toThrow(/fencing|lease/i);

    const routed = dispatches.attachRoute({
      taskId: task.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    const running = dispatches.bindSpawn({
      taskId: task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
      workerIncarnationId: claim.workerIncarnationId,
      paneId: 'pane-1',
      sessionId: 'session-1',
    });
    expect(running).toMatchObject({
      state: 'running', paneId: 'pane-1', sessionId: 'session-1',
    });

    runtime.close(scope);
    expect(createTaskDispatchStore(runtime, scope).get(task.id)).toMatchObject({
      state: 'running',
      routeReservationId: route.id,
      paneId: 'pane-1',
      sessionId: 'session-1',
      workerIncarnationId: claim.workerIncarnationId,
    });
  });

  it('fences a sealed plan to the exact roster agent and route contract', () => {
    const runtime = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope);
    const contract = approvedIntentContract({ goal: 'Roster exato', intentVersion: 1 });
    const mission = missions.create({
      title: 'Roster',
      squadId: 'squad-a',
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const [task] = tasks.createPlanAtomically({
      missionId: mission.id,
      intentVersion: 1,
      squad: {
        id: 'squad-a',
        agents: [{
          id: 'backend',
          agentName: 'Backend',
          category: 'executor',
          cli: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
          allowedTools: ['nexus_handoff_submit'],
        }],
      },
      rows: [{
        plannerId: 'backend-fix',
        title: 'Backend fix',
        detail: encodeTaskScheduleDetail('Corrigir backend', {
          dependsOn: [],
          ownership: { files: ['src/backend.ts'], symbols: [], domains: [] },
          merged: false,
          agentRef: 'backend',
          agentCategory: 'executor',
          executionMode: 'isolated_worktree',
        }),
        agentRef: 'backend',
        agentCategory: 'executor',
      }],
    });
    const receipt = tasks.getPlanReceipt(mission.id, 1)!;
    expect(() => dispatches.claim({
      missionId: mission.id,
      taskId: task!.id,
      intentVersion: 1,
      workerId: 'Backend',
      leaseOwner: 'main',
      leaseMs: 30_000,
    })).toThrow(/plano selado exige/i);

    expect(() => dispatches.claim({
      missionId: mission.id,
      taskId: task!.id,
      intentVersion: 1,
      workerId: 'Backend',
      leaseOwner: 'main',
      leaseMs: 30_000,
      agentRef: 'backend',
      agentCategory: 'executor',
      rosterHash: receipt.rosterHash,
      routeContract: { adapterId: 'agy', model: 'gemini-3.6-flash-high', effort: 'high' },
      ownership: { files: ['src/backend.ts'], symbols: [], domains: [] },
    })).toThrow(/provider.*roster/i);

    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task!.id,
      intentVersion: 1,
      workerId: 'Backend',
      leaseOwner: 'main',
      leaseMs: 30_000,
      agentRef: 'backend',
      agentCategory: 'executor',
      rosterHash: receipt.rosterHash,
      routeContract: {
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
      ownership: { files: ['src/backend.ts'], symbols: [], domains: [] },
    });
    const route = missions.reserveRouteDecision(mission.id, task!.title, {
      tier: 'hard', adapterId: 'codex', model: 'gpt-5.6-sol', effort: 'high',
      reason: 'rota selada', alternatives: [],
    });
    expect(() => dispatches.attachRoute({
      taskId: task!.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      adapterId: 'agy',
      model: 'gemini-3.6-pro',
      effort: 'high',
    })).toThrow(/route contract|provider substituto/i);
    const routed = dispatches.attachRoute({
      taskId: task!.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(routed).toMatchObject({
      agentRef: 'backend',
      agentCategory: 'executor',
      rosterHash: receipt.rosterHash,
      routeContract: {
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
    });
    missions.update(mission.id, {
      intentVersion: 2,
      intentContract: approvedIntentContract({
        goal: 'Roster exato revisado', intentVersion: 2,
      }),
      intentState: 'executing',
      status: 'running',
    });
    expect(tasks.getPlanReceipt(mission.id, 1)).toMatchObject({
      planHash: receipt.planHash,
      tasks: [{ taskId: task!.id }],
    });
    expect(tasks.list(mission.id)[0]).toMatchObject({ status: 'failed' });
  });

  it('blocks an unavailable sealed worker before claim without corrupting its receipt', () => {
    const runtime = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope);
    const contract = approvedIntentContract({ goal: 'Falhar fechado', intentVersion: 4 });
    const mission = missions.create({
      title: 'Roster indisponível', squadId: 'squad-sealed', intentVersion: 4,
      intentState: 'dispatched', intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const [task] = tasks.createPlanAtomically({
      missionId: mission.id,
      intentVersion: 4,
      squad: {
        id: 'squad-sealed',
        agents: [{
          id: 'reviewer', agentName: 'Reviewer', category: 'reviewer',
          cli: 'claude', model: 'claude-sonnet-5',
        }],
      },
      rows: [{
        plannerId: 'review', title: 'Revisar', detail: 'Receipt imutável',
        agentRef: 'reviewer', agentCategory: 'reviewer',
      }],
    });
    const original = tasks.getPlanReceipt(mission.id, 4)!;

    expect(dispatches.blockBeforeClaim({
      missionId: mission.id,
      taskId: task!.id,
      intentVersion: 4,
      reason: 'A CLI exata do reviewer não está instalada.',
    })).toBe(true);
    expect(dispatches.get(task!.id)).toBeNull();
    expect(missions.get(mission.id)).toMatchObject({ status: 'blocked' });
    expect(tasks.getPlanReceipt(mission.id, 4)).toMatchObject({
      planHash: original.planHash,
      tasks: [{ taskId: task!.id, detail: 'Receipt imutável' }],
    });
    expect(tasks.list(mission.id)[0]).toMatchObject({
      status: 'failed', detail: 'Receipt imutável',
    });
    expect(dispatches.blockBeforeClaim({
      missionId: mission.id,
      taskId: task!.id,
      intentVersion: 4,
      reason: 'Replay do mesmo bloqueio.',
    })).toBe(false);
  });

  it('marks an unfrozen mission done only after integration and accepted handoff delivery proof', () => {
    const runtime = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const handoffs = createScopedHandoffStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope);
    const contract = approvedIntentContract({
      goal: 'Completar pelo motor com prova real', intentVersion: 7,
    });
    const mission = missions.create({
      title: 'Golden path', squadId: 'golden-squad', intentVersion: 7,
      intentState: 'executing', intentContract: contract,
      orchestratorSessionId: 'orchestrator-golden',
    });
    missions.setStatus(mission.id, 'running');
    const ownership = { files: ['src/golden.ts'], symbols: [], domains: [] };
    const [task] = tasks.createPlanAtomically({
      missionId: mission.id,
      intentVersion: 7,
      squad: {
        id: 'golden-squad',
        agents: [{
          id: 'worker', agentName: 'Golden Worker', category: 'executor',
          cli: 'codex', model: 'gpt-5.6-sol', effort: 'high',
        }],
      },
      rows: [{
        plannerId: 'implement', title: 'Implementar golden path',
        detail: encodeTaskScheduleDetail('Implementar e testar.', {
          dependsOn: [], ownership, merged: false, agentRef: 'worker',
          agentCategory: 'executor', executionMode: 'isolated_worktree',
        }),
        agentRef: 'worker', agentCategory: 'executor',
      }],
    });
    const receipt = tasks.getPlanReceipt(mission.id, 7)!;
    const route = missions.reserveRouteDecision(mission.id, task!.title, {
      tier: 'hard', adapterId: 'codex', model: 'gpt-5.6-sol', effort: 'high',
      reason: 'roster selado', alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id, taskId: task!.id, intentVersion: 7,
      workerId: 'Golden Worker', leaseOwner: 'main', leaseMs: 30_000,
      ownership, executionMode: 'isolated_worktree', agentRef: 'worker',
      agentCategory: 'executor', rosterHash: receipt.rosterHash,
      routeContract: {
        adapterId: 'codex', model: 'gpt-5.6-sol', effort: 'high',
      },
    });
    const routed = dispatches.attachRoute({
      taskId: task!.id, revision: claim.revision, leaseToken: claim.leaseToken,
      routeReservationId: route.id, adapterId: 'codex',
      model: 'gpt-5.6-sol', effort: 'high',
    });
    dispatches.bindSpawn({
      taskId: task!.id, revision: routed.revision, leaseToken: claim.leaseToken,
      workerIncarnationId: claim.workerIncarnationId,
      paneId: 'pane-golden', sessionId: 'session-golden',
    });
    const handoff = handoffs.submit({
      missionId: mission.id, sessionId: 'session-golden',
      workerIncarnationId: claim.workerIncarnationId,
      fromAgent: 'Golden Worker', status: 'success',
      summary: 'Implementação integrada com testes e commit local verificados.',
    });
    const ready = dispatches.acceptHandoff({
      sessionId: 'session-golden',
      workerIncarnationId: claim.workerIncarnationId,
      handoffId: handoff.id,
    });
    dispatches.completeByCoordinator({
      taskId: task!.id,
      revision: ready.revision,
      receipt: {
        kind: 'worktree_integrated', reference: 'a'.repeat(40),
        completedAt: Date.now(), evidenceIds: ['evidence-golden'],
      },
    });

    expect(dispatches.completeMissionFromVerifiedPlan({
      missionId: mission.id, intentVersion: 7,
    })).toBe(false);
    expect(missions.get(mission.id)?.status).toBe('running');

    const attempt = handoffs.reserveDeliveryAttempt({
      handoffId: handoff.id,
      missionId: mission.id,
      orchestratorSessionId: 'orchestrator-golden',
      maxAttempts: 2,
    });
    handoffs.markDeliveryAttemptPasted({
      attemptId: attempt.id,
      handoffId: handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(handoffs.acceptDeliveryAttempt({
      attemptId: attempt.id, handoffId: handoff.id,
    })).toBe(true);

    runtime.close(scope);
    const restartedMissions = createScopedMissionStore(runtime, scope);
    const restartedDispatches = createTaskDispatchStore(runtime, scope);
    const restartedHandoffs = createScopedHandoffStore(runtime, scope);
    restartedMissions.rebindOrchestratorSession(
      mission.id,
      'orchestrator-golden-rebound',
    );
    expect(restartedHandoffs.get(handoff.id)).toMatchObject({
      delivered: false,
      deliveryState: 'queued',
    });
    expect(restartedHandoffs.listDeliveryAttempts(handoff.id)).toMatchObject([
      {
        attemptNo: 1,
        state: 'accepted',
        orchestratorSessionId: 'orchestrator-golden',
      },
    ]);
    expect(restartedDispatches.completeMissionFromVerifiedPlan({
      missionId: mission.id, intentVersion: 7,
    })).toBe(false);
    expect(restartedMissions.get(mission.id)?.status).toBe('running');

    const reboundAttempt = restartedHandoffs.reserveDeliveryAttempt({
      handoffId: handoff.id,
      missionId: mission.id,
      orchestratorSessionId: 'orchestrator-golden-rebound',
      maxAttempts: 2,
    });
    restartedHandoffs.markDeliveryAttemptPasted({
      attemptId: reboundAttempt.id,
      handoffId: handoff.id,
      acceptDeadlineAt: Date.now() + 10_000,
    });
    expect(restartedHandoffs.acceptDeliveryAttempt({
      attemptId: reboundAttempt.id,
      handoffId: handoff.id,
    })).toBe(true);
    expect(restartedDispatches.get(task!.id)?.integrationReceipt).toEqual({
      kind: 'worktree_integrated',
      reference: 'a'.repeat(40),
      completedAt: expect.any(Number),
      evidenceIds: ['evidence-golden'],
    });
    restartedMissions.update(mission.id, {
      status: 'running',
      intentState: 'awaiting_approval',
    });
    expect(restartedDispatches.completeMissionFromVerifiedPlan({
      missionId: mission.id, intentVersion: 7,
    })).toBe(false);
    expect(restartedMissions.get(mission.id)?.status).toBe('running');
    restartedMissions.update(mission.id, {
      status: 'running',
      intentState: 'validating',
    });
    runtime.open(scope).db.prepare(
      `UPDATE mission_task_plans SET roster_hash = ?
       WHERE mission_id = ? AND intent_version = ?`,
    ).run('0'.repeat(64), mission.id, 7);
    expect(() => restartedDispatches.completeMissionFromVerifiedPlan({
      missionId: mission.id, intentVersion: 7,
    })).toThrow(/roster hash|corrupt/i);
    expect(restartedMissions.get(mission.id)?.status).toBe('running');
    runtime.open(scope).db.prepare(
      `UPDATE mission_task_plans SET roster_hash = ?
       WHERE mission_id = ? AND intent_version = ?`,
    ).run(receipt.rosterHash, mission.id, 7);
    expect(restartedDispatches.completeMissionFromVerifiedPlan({
      missionId: mission.id, intentVersion: 7,
    })).toBe(true);
    expect(restartedMissions.get(mission.id)).toMatchObject({
      status: 'done', intentState: 'done',
    });
    expect(restartedMissions.get(mission.id)?.learnings).toMatch(
      /Conclusão automática verificada[\s\S]*handoffs entregues/i,
    );
    expect(restartedDispatches.completeMissionFromVerifiedPlan({
      missionId: mission.id, intentVersion: 7,
    })).toBe(false);
  });

  it('never completes from status alone: exact-session handoff and integration receipt are required', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const handoffs = createScopedHandoffStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({ goal: 'Entregar prova', intentVersion: 1 });
    const mission = missions.create({
      title: 'Prova', intentVersion: 1, intentState: 'dispatched', intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Worker' });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'medium', adapterId: 'codex', model: 'gpt-5.6-sol', effort: 'medium',
      reason: 'rota autoritativa para o worker', alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id, taskId: task.id, intentVersion: 1,
      workerId: 'worker-1', leaseOwner: 'main', leaseMs: 30_000,
      executionMode: 'same_checkout',
    });
    const routed = dispatches.attachRoute({
      taskId: task.id, revision: claim.revision, leaseToken: claim.leaseToken,
      routeReservationId: route.id, adapterId: 'codex',
    });
    const running = dispatches.bindSpawn({
      taskId: task.id, revision: routed.revision, leaseToken: claim.leaseToken,
      workerIncarnationId: claim.workerIncarnationId,
      paneId: 'pane-1', sessionId: 'session-active',
    });

    expect(() => dispatches.completeByCoordinator({
      taskId: task.id,
      revision: running.revision,
      receipt: {
        kind: 'same_checkout_validated',
        reference: 'premature-receipt',
        completedAt: 10,
      },
    })).toThrow(/handoff|merge/i);
    expect(() => dispatches.acceptHandoff({
      sessionId: 'session-stale',
      workerIncarnationId: claim.workerIncarnationId,
      handoffId: 'handoff-stale',
    })).toThrow(/dispatch ativo|sessão/i);

    const handoff = handoffs.submit({
      missionId: mission.id,
      sessionId: 'session-active',
      workerIncarnationId: claim.workerIncarnationId,
      fromAgent: 'worker-1',
      status: 'success',
      summary: 'Implementação concluída com testes verdes e evidência durável.',
    });
    const ready = dispatches.acceptHandoff({
      sessionId: 'session-active',
      workerIncarnationId: claim.workerIncarnationId,
      handoffId: handoff.id,
    });
    expect(tasks.list(mission.id)[0]?.status).toBe('running');
    expect(() => dispatches.completeByCoordinator({
      taskId: task.id,
      revision: ready.revision,
      receipt: {
        kind: 'same_checkout_validated',
        reference: handoff.id,
        completedAt: Date.now(),
      },
    })).toThrow(/sintético|proibido/i);
    const blocked = dispatches.blockUnvalidatedByCoordinator({
      taskId: task.id,
      revision: ready.revision,
      reason:
        'same_checkout legado não possui baseline/diff atribuível; replaneje com ownership explícito.',
    });
    expect(blocked.state).toBe('blocked');
    expect(tasks.list(mission.id)[0]?.status).toBe('failed');
    expect(missions.get(mission.id)).toMatchObject({ status: 'blocked' });
  });

  it('rejects an expired lease and renews only from the exact bound session', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let now = 1_000;
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope, { now: () => now });
    const tasks = createScopedTaskStore(runtime, scope, { now: () => now });
    const dispatches = createTaskDispatchStore(runtime, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({ goal: 'Heartbeat', intentVersion: 1 });
    const mission = missions.create({
      title: 'Heartbeat', intentVersion: 1, intentState: 'dispatched', intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Worker vivo' });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'medium', adapterId: 'codex', effort: 'medium',
      reason: 'rota de heartbeat', alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id, taskId: task.id, intentVersion: 1,
      workerId: 'worker-heartbeat', leaseOwner: 'main', leaseMs: 1_000,
    });
    now = 2_001;
    expect(() => dispatches.attachRoute({
      taskId: task.id, revision: claim.revision, leaseToken: claim.leaseToken,
      routeReservationId: route.id, adapterId: 'codex',
    })).toThrow(/expirad/i);

    now = 3_000;
    const liveContract = approvedIntentContract({ goal: 'Worker vivo', intentVersion: 2 });
    const liveMission = missions.create({
      title: 'Worker vivo', intentVersion: 2, intentState: 'dispatched',
      intentContract: liveContract,
    });
    missions.setStatus(liveMission.id, 'running');
    const liveTask = tasks.create({ missionId: liveMission.id, title: 'Renovar lease' });
    const liveRoute = missions.reserveRouteDecision(liveMission.id, liveTask.title, {
      tier: 'medium', adapterId: 'codex', effort: 'medium',
      reason: 'rota de worker vivo', alternatives: [],
    });
    const liveClaim = dispatches.claim({
      missionId: liveMission.id, taskId: liveTask.id, intentVersion: 2,
      workerId: 'worker-live', leaseOwner: 'main', leaseMs: 1_000,
    });
    const routed = dispatches.attachRoute({
      taskId: liveTask.id, revision: liveClaim.revision,
      leaseToken: liveClaim.leaseToken, routeReservationId: liveRoute.id,
      adapterId: 'codex',
    });
    dispatches.bindSpawn({
      taskId: liveTask.id, revision: routed.revision,
      leaseToken: liveClaim.leaseToken, paneId: 'pane-live',
      sessionId: 'session-live',
      workerIncarnationId: liveClaim.workerIncarnationId,
    });
    now = 5_000;
    expect(() => dispatches.heartbeat({
      sessionId: 'session-forged', missionId: liveMission.id,
      workerIncarnationId: liveClaim.workerIncarnationId, leaseMs: 30_000,
    })).toThrow(/sess[aã]o|dispatch/i);
    expect(() => dispatches.heartbeat({
      sessionId: 'session-live', missionId: mission.id,
      workerIncarnationId: liveClaim.workerIncarnationId, leaseMs: 30_000,
    })).toThrow(/sess[aã]o|dispatch/i);
    expect(() => dispatches.heartbeat({
      sessionId: 'session-live', missionId: liveMission.id,
      workerIncarnationId: 'worker-incarnation-stale', leaseMs: 30_000,
    })).toThrow(/sess[aã]o|dispatch/i);
    const renewed = dispatches.heartbeat({
      sessionId: 'session-live', missionId: liveMission.id,
      workerIncarnationId: liveClaim.workerIncarnationId, leaseMs: 30_000,
    });
    expect(renewed).toMatchObject({
      state: 'running', sessionId: 'session-live', leaseExpiresAt: 35_000,
      lastHeartbeatAt: 5_000,
    });
  });

  it('blocks an expired uncertain spawn durably with one PT-BR CTA', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let now = 1_000;
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope, { now: () => now });
    const tasks = createScopedTaskStore(runtime, scope, { now: () => now });
    const dispatches = createTaskDispatchStore(runtime, scope, {
      now: () => now,
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({ goal: 'Recuperar restart', intentVersion: 1 });
    const mission = missions.create({
      title: 'Restart', intentVersion: 1, intentState: 'dispatched', intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Spawn incerto' });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'hard', adapterId: 'codex', effort: 'high',
      reason: 'rota antes do crash', alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id, taskId: task.id, intentVersion: 1,
      workerId: 'worker-restart', leaseOwner: 'main', leaseMs: 1_000,
    });
    const routed = dispatches.attachRoute({
      taskId: task.id, revision: claim.revision, leaseToken: claim.leaseToken,
      routeReservationId: route.id, adapterId: 'codex',
    });
    const spawning = dispatches.markSpawning({
      taskId: task.id, revision: routed.revision, leaseToken: claim.leaseToken,
    });
    now = 2_001;

    const blocked = dispatches.blockExpired({
      taskId: task.id,
      revision: spawning.revision,
      reason: 'O Nexus reiniciou antes de provar qual pane recebeu esta tarefa.',
    });
    expect(blocked.state).toBe('blocked');
    expect(tasks.list(mission.id)[0]?.status).toBe('failed');
    const blockedMission = missions.get(mission.id)!;
    expect(blockedMission.status).toBe('blocked');
    expect(blockedMission.description).toMatch(/Retomar miss[aã]o/i);
    expect(blockedMission.description.match(/NEXUS_TASK_DISPATCH_BLOCKED/g)).toHaveLength(1);

    expect(dispatches.blockExpired({
      taskId: task.id,
      revision: blocked.revision,
      reason: 'replay idempotente',
    }).state).toBe('blocked');
    expect(missions.get(mission.id)?.description.match(
      /NEXUS_TASK_DISPATCH_BLOCKED/g,
    )).toHaveLength(1);
  });

  it('blocks immediately when the exact running worker exits without handoff', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({ goal: 'Detectar worker morto', intentVersion: 1 });
    const mission = missions.create({
      title: 'Worker morto', intentVersion: 1, intentState: 'dispatched',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Worker' });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'medium', adapterId: 'codex', effort: 'medium',
      reason: 'rota de lifecycle', alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id, taskId: task.id, intentVersion: 1,
      workerId: 'worker-exit', leaseOwner: 'main', leaseMs: 30_000,
    });
    const routed = dispatches.attachRoute({
      taskId: task.id, revision: claim.revision, leaseToken: claim.leaseToken,
      routeReservationId: route.id, adapterId: 'codex',
    });
    dispatches.bindSpawn({
      taskId: task.id, revision: routed.revision, leaseToken: claim.leaseToken,
      paneId: 'pane-exit', sessionId: 'session-exit',
      workerIncarnationId: claim.workerIncarnationId,
    });

    expect(dispatches.blockSessionExit({
      sessionId: 'session-exit',
      workerIncarnationId: 'worker-incarnation-stale',
      reason: 'Saída tardia da encarnação anterior.',
    })).toBeNull();
    const blocked = dispatches.blockSessionExit({
      sessionId: 'session-exit',
      workerIncarnationId: claim.workerIncarnationId,
      reason: 'O worker encerrou sem entregar handoff confiável.',
    });
    expect(blocked).toMatchObject({ state: 'blocked', sessionId: 'session-exit' });
    expect(missions.get(mission.id)?.status).toBe('blocked');
    expect(tasks.list(mission.id)[0]?.status).toBe('failed');
    expect(dispatches.blockSessionExit({
      sessionId: 'session-exit',
      workerIncarnationId: claim.workerIncarnationId,
      reason: 'evento duplicado',
    })).toBeNull();
  });

  it('supersedes a running dispatch when intent changes and rejects late worker effects', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const handoffs = createScopedHandoffStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contractV1 = approvedIntentContract({
      goal: 'Implementar contrato inicial', intentVersion: 1,
    });
    const mission = missions.create({
      title: 'Intent fence', intentVersion: 1, intentState: 'executing',
      intentContract: contractV1,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({ missionId: mission.id, title: 'Worker antigo' });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'hard', adapterId: 'codex', model: 'gpt-5.6-sol', effort: 'high',
      reason: 'rota vinculada à intenção 1', alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id, taskId: task.id, intentVersion: 1,
      workerId: 'worker-intent-v1', leaseOwner: 'main', leaseMs: 30_000,
    });
    const routed = dispatches.attachRoute({
      taskId: task.id, revision: claim.revision, leaseToken: claim.leaseToken,
      routeReservationId: route.id, adapterId: 'codex', model: 'gpt-5.6-sol',
    });
    dispatches.bindSpawn({
      taskId: task.id, revision: routed.revision, leaseToken: claim.leaseToken,
      paneId: 'pane-intent-v1', sessionId: 'session-intent-v1',
      workerIncarnationId: claim.workerIncarnationId,
    });

    const contractV2 = approvedIntentContract({
      goal: 'Contrato revisado pelo operador', intentVersion: 2,
    });
    const revised = missions.update(mission.id, {
      description: 'Descrição revisada para o contrato novo.',
      intentVersion: 2,
      intentContract: contractV2,
      intentState: 'executing',
      status: 'running',
    });

    expect(revised).toMatchObject({ intentVersion: 2, status: 'blocked' });
    expect(revised?.description).toContain(
      'Descrição revisada para o contrato novo.',
    );
    expect(revised?.description).toMatch(/Retomar miss[aã]o/i);
    expect(dispatches.get(task.id)).toMatchObject({
      intentVersion: 1,
      state: 'superseded',
    });
    expect(tasks.list(mission.id)[0]).toMatchObject({ status: 'failed' });
    expect(() => dispatches.heartbeat({
      sessionId: 'session-intent-v1', missionId: mission.id,
      workerIncarnationId: claim.workerIncarnationId, leaseMs: 30_000,
    })).toThrow(/dispatch|inten[cç][aã]o|running/i);

    const lateHandoff = handoffs.submit({
      missionId: mission.id,
      sessionId: 'session-intent-v1',
      workerIncarnationId: claim.workerIncarnationId,
      fromAgent: 'worker-intent-v1',
      status: 'success',
      summary: 'Resultado tardio que não pode concluir a intenção revisada.',
    });
    expect(() => dispatches.acceptHandoff({
      sessionId: 'session-intent-v1',
      workerIncarnationId: claim.workerIncarnationId,
      handoffId: lateHandoff.id,
    })).toThrow(/dispatch ativo|sess[aã]o|inten[cç][aã]o/i);
    expect(tasks.list(mission.id)[0]?.status).not.toBe('done');
  });

  it.each(['blocked', 'failed'] as const)(
    'revoga atomicamente dispatch atual quando missão vira %s',
    (terminalStatus) => {
      const runtime = manager();
      const scope = testProjectScope();
      let id = 0;
      const missions = createScopedMissionStore(runtime, scope);
      const tasks = createScopedTaskStore(runtime, scope);
      const handoffs = createScopedHandoffStore(runtime, scope);
      const dispatches = createTaskDispatchStore(runtime, scope, {
        idFactory: (prefix) => `${prefix}-${++id}`,
      });
      const baseContract = approvedIntentContract({
        goal: 'Executar trabalho com revogação forte',
        intentVersion: 1,
      });
      const mission = missions.create({
        title: 'Lifecycle fence',
        intentVersion: 1,
        intentState: 'dispatched',
        intentContract: {
          ...baseContract,
          approvedAt: 1,
          dispatchedAt: 1,
        },
      });
      missions.setStatus(mission.id, 'running');
      const task = tasks.create({ missionId: mission.id, title: 'Worker atual' });
      const route = missions.reserveRouteDecision(mission.id, task.title, {
        tier: 'hard',
        adapterId: 'codex',
        effort: 'high',
        reason: 'rota atual',
        alternatives: [],
      });
      const claim = dispatches.claim({
        missionId: mission.id,
        taskId: task.id,
        intentVersion: 1,
        workerId: 'worker-current',
        leaseOwner: 'main',
        leaseMs: 30_000,
      });
      const routed = dispatches.attachRoute({
        taskId: task.id,
        revision: claim.revision,
        leaseToken: claim.leaseToken,
        routeReservationId: route.id,
        adapterId: 'codex',
      });
      dispatches.bindSpawn({
        taskId: task.id,
        revision: routed.revision,
        leaseToken: claim.leaseToken,
        paneId: 'pane-current',
        sessionId: 'session-current',
        workerIncarnationId: claim.workerIncarnationId,
      });
      const handoff = handoffs.submit({
        missionId: mission.id,
        sessionId: 'session-current',
        workerIncarnationId: claim.workerIncarnationId,
        fromAgent: 'worker-current',
        status: 'success',
        summary: 'Resultado produzido antes da revogação da missão.',
      });

      const demoted = missions.setStatus(mission.id, terminalStatus);
      expect(demoted).toMatchObject({
        status: terminalStatus,
        intentState:
          terminalStatus === 'blocked' ? 'blocked_user' : 'blocked_technical',
      });
      expect(hasCurrentDispatchAuthority(demoted!)).toBe(false);
      expect(dispatches.get(task.id)).toMatchObject({ state: 'superseded' });
      expect(tasks.list(mission.id)[0]).toMatchObject({ status: 'failed' });
      expect(() => dispatches.acceptHandoff({
        sessionId: 'session-current',
        workerIncarnationId: claim.workerIncarnationId,
        handoffId: handoff.id,
      })).toThrow(/dispatch|running|autoridade|miss[aã]o/i);
      expect(() => dispatches.blockFromHandoff({
        sessionId: 'session-current',
        workerIncarnationId: claim.workerIncarnationId,
        handoffId: handoff.id,
        detail: 'Evento tardio não pode reabrir uma missão terminal.',
      })).toThrow(/dispatch|running|autoridade|miss[aã]o/i);
      expect(dispatches.get(task.id)?.integrationReceipt).toBeUndefined();
    },
  );

  it('revoga entre validação e merge sem aceitar receipt ou conclusão tardia', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const handoffs = createScopedHandoffStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const contract = approvedIntentContract({
      goal: 'Revogar antes do efeito Git',
      intentVersion: 1,
    });
    const mission = missions.create({
      title: 'Race merge',
      intentVersion: 1,
      intentState: 'validating',
      intentContract: contract,
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({
      missionId: mission.id,
      title: 'Candidato já validado',
    });
    const route = missions.reserveRouteDecision(mission.id, task.title, {
      tier: 'hard',
      adapterId: 'codex',
      effort: 'high',
      reason: 'rota corrente',
      alternatives: [],
    });
    const claim = dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-race',
      leaseOwner: 'main',
      leaseMs: 30_000,
    });
    const routed = dispatches.attachRoute({
      taskId: task.id,
      revision: claim.revision,
      leaseToken: claim.leaseToken,
      routeReservationId: route.id,
      adapterId: 'codex',
    });
    dispatches.bindSpawn({
      taskId: task.id,
      revision: routed.revision,
      leaseToken: claim.leaseToken,
      paneId: 'pane-race',
      sessionId: 'session-race',
      workerIncarnationId: claim.workerIncarnationId,
    });
    const handoff = handoffs.submit({
      missionId: mission.id,
      sessionId: 'session-race',
      workerIncarnationId: claim.workerIncarnationId,
      fromAgent: 'worker-race',
      status: 'success',
      summary: 'Candidato validado, ainda sem integração no checkout principal.',
    });
    const ready = dispatches.acceptHandoff({
      sessionId: 'session-race',
      workerIncarnationId: claim.workerIncarnationId,
      handoffId: handoff.id,
    });
    const merging = dispatches.beginMerge({
      taskId: task.id,
      revision: ready.revision,
    });

    missions.setStatus(mission.id, 'blocked');

    expect(() => dispatches.completeByCoordinator({
      taskId: task.id,
      revision: merging.revision,
      receipt: {
        kind: 'worktree_integrated',
        reference: 'b'.repeat(40),
        completedAt: Date.now(),
        evidenceIds: ['evidence-race'],
      },
    })).toThrow(/autoridade|running|dispatch|merge|inten[cç][aã]o/i);
    expect(dispatches.get(task.id)).toMatchObject({
      state: 'superseded',
      integrationReceipt: undefined,
    });
    expect(tasks.list(mission.id)[0]).toMatchObject({ status: 'failed' });
    expect(missions.get(mission.id)).toMatchObject({ status: 'blocked' });
  });

  it('não avança uma transição com contrato ainda não aprovado', () => {
    const runtime = manager();
    const scope = testProjectScope();
    let id = 0;
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope, {
      idFactory: (prefix) => `${prefix}-${++id}`,
    });
    const mission = missions.create({
      title: 'Sem aprovação',
      intentVersion: 1,
      intentState: 'dispatched',
      intentContract: compileIntentContract({
        goal: 'Aguardar aprovação real',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({
      missionId: mission.id,
      title: 'Não pode reservar worker',
    });

    expect(() => dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-unapproved',
      leaseOwner: 'main',
      leaseMs: 30_000,
    })).toThrow(/aprovad|autoridade|contrato/i);
    expect(dispatches.get(task.id)).toBeNull();
    expect(tasks.list(mission.id)[0]).toMatchObject({ status: 'pending' });
  });

  it('não cria claim fora de dispatched, executing ou validating', () => {
    const runtime = manager();
    const scope = testProjectScope();
    const missions = createScopedMissionStore(runtime, scope);
    const tasks = createScopedTaskStore(runtime, scope);
    const dispatches = createTaskDispatchStore(runtime, scope);
    const mission = missions.create({
      title: 'Aguardando nova aprovação',
      intentVersion: 1,
      intentState: 'awaiting_approval',
      intentContract: approvedIntentContract({
        goal: 'Não reutilizar aprovação fora do lifecycle',
        intentVersion: 1,
      }),
    });
    missions.setStatus(mission.id, 'running');
    const task = tasks.create({
      missionId: mission.id,
      title: 'Ainda não despachar',
    });

    expect(() => dispatches.claim({
      missionId: mission.id,
      taskId: task.id,
      intentVersion: 1,
      workerId: 'worker-waiting',
      leaseOwner: 'main',
      leaseMs: 30_000,
    })).toThrow(/autoridade lifecycle|intent=awaiting_approval/i);
    expect(dispatches.get(task.id)).toBeNull();
    expect(tasks.list(mission.id)[0]).toMatchObject({ status: 'pending' });
  });
});
