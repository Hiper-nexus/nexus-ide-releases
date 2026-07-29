import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { compileIntentContract } from '../../shared/mission-intent';
import { testProjectScope } from './__tests__/scope-fixture';
import { createScopedMissionStore } from './mission-store';
import { createScopedTaskStore } from './task-store';
import { createTaskDispatchStore } from './task-dispatch-store';
import { encodeTaskScheduleDetail } from './mission-scheduler-meta';

const registryMocks = vi.hoisted(() => ({
  requestMissionWorkerPaneRetirement: vi.fn(async () => true),
}));

const driverMocks = vi.hoisted(() => ({
  requestMissionDriverTick: vi.fn(() => true),
}));

vi.mock('./pane-registry', () => ({
  requestMissionWorkerPaneRetirement:
    registryMocks.requestMissionWorkerPaneRetirement,
}));

vi.mock('./mission-driver-runtime', () => ({
  requestMissionDriverTick: driverMocks.requestMissionDriverTick,
}));

import {
  configureProviderFailureWaiver,
  handleMissionWorkerProviderNoRoute,
} from './provider-failure-waiver';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({
    baseDir,
    appVersion: '0.19.27-test',
  });
  managers.push(value);
  return value;
}

function approvedIntentContract(
  input: Parameters<typeof compileIntentContract>[0],
): ReturnType<typeof compileIntentContract> {
  return {
    ...compileIntentContract(input),
    approvedAt: 1,
    dispatchedAt: 1,
  };
}

let fixtureSequence = 0;
function runningWorkerFixture(options: { executor?: boolean } = {}) {
  const suffix = `glue-${++fixtureSequence}`;
  const paneId = `pane-${suffix}`;
  const sessionId = `session-${suffix}`;
  const runtime = manager();
  const scope = testProjectScope();
  const missions = createScopedMissionStore(runtime, scope);
  const tasks = createScopedTaskStore(runtime, scope);
  const dispatches = createTaskDispatchStore(runtime, scope);
  const executor = options.executor === true;
  const agentCategory = executor
    ? ('executor' as const)
    : ('architect' as const);
  const executionMode = executor
    ? ('isolated_worktree' as const)
    : ('read_only' as const);
  const ownership = {
    files: ['src'],
    symbols: [],
    domains: executor ? [] : ['guided-advisory', 'sequential-only'],
  };
  const mission = missions.create({
    title: 'Worker sem provider',
    squadId: 'agentic-guided-squad',
    intentVersion: 4,
    intentState: 'executing',
    intentContract: approvedIntentContract({
      goal: 'Mapear riscos antes da execução principal',
      intentVersion: 4,
    }),
    orchestratorSessionId: 'orchestrator-guided-advisor',
  });
  missions.setStatus(mission.id, 'running');
  const [task] = tasks.createPlanAtomically({
    missionId: mission.id,
    intentVersion: 4,
    squad: {
      id: 'agentic-guided-squad',
      agents: [
        {
          id: 'advisor',
          agentName: 'Advisor independente',
          category: agentCategory,
          cli: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
        },
      ],
    },
    rows: [
      {
        plannerId: 'guided-advisory-1-advisor',
        title: 'Mapear riscos',
        detail: encodeTaskScheduleDetail('Inspecione sem editar.', {
          dependsOn: [],
          ownership,
          merged: false,
          agentRef: 'advisor',
          agentCategory,
          executionMode,
        }),
        agentRef: 'advisor',
        agentCategory,
      },
    ],
  });
  const planReceipt = tasks.getPlanReceipt(mission.id, 4)!;
  const route = missions.reserveRouteDecision(mission.id, task!.title, {
    tier: 'hard',
    adapterId: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    reason: 'rota selada',
    alternatives: [],
  });
  const claim = dispatches.claim({
    missionId: mission.id,
    taskId: task!.id,
    intentVersion: 4,
    workerId: 'Advisor independente',
    leaseOwner: 'main',
    leaseMs: 30_000,
    ownership,
    executionMode,
    agentRef: 'advisor',
    agentCategory,
    rosterHash: planReceipt.rosterHash,
    routeContract: {
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    },
  });
  const routed = dispatches.attachRoute({
    taskId: task!.id,
    revision: claim.revision,
    leaseToken: claim.leaseToken,
    routeReservationId: route.id,
    adapterId: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  });
  missions.consumeRouteReservation(
    {
      reservationId: route.id,
      missionId: mission.id,
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    },
    `dispatch:${claim.id}`,
  );
  dispatches.bindSpawn({
    taskId: task!.id,
    revision: routed.revision,
    leaseToken: claim.leaseToken,
    workerIncarnationId: claim.workerIncarnationId,
    paneId,
    sessionId,
  });
  return {
    runtime,
    scope,
    missions,
    tasks,
    dispatches,
    mission,
    task: task!,
    claim,
    paneId,
    sessionId,
  };
}

function noRouteInputFor(
  fixture: ReturnType<typeof runningWorkerFixture>,
) {
  return {
    scope: fixture.scope,
    missionId: fixture.mission.id,
    paneId: fixture.paneId,
    sessionId: fixture.sessionId,
    workerIncarnationId: fixture.claim.workerIncarnationId,
    adapterId: 'codex',
    hit: {
      kind: 'rate-limit' as const,
      reason: 'rate limit',
      cooldownMs: 60_000,
    },
  };
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-provider-waiver-'));
  registryMocks.requestMissionWorkerPaneRetirement.mockClear();
  driverMocks.requestMissionDriverTick.mockClear();
});

afterEach(() => {
  configureProviderFailureWaiver({ runtimeManager: null });
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('provider failure waiver glue (Main-owned)', () => {
  it('waives a sealed root advisory: receipt persisted, exact close requested, scheduler tick requested', () => {
    const fixture = runningWorkerFixture();
    configureProviderFailureWaiver({ runtimeManager: fixture.runtime });

    const outcome = handleMissionWorkerProviderNoRoute(
      noRouteInputFor(fixture),
    );

    expect(outcome).toBe('waived');
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      state: 'completed',
      handoffId: undefined,
      integrationReceipt: {
        kind: 'advisory_provider_unavailable',
        waiver: {
          missionId: fixture.mission.id,
          sessionId: fixture.sessionId,
          workerIncarnationId: fixture.claim.workerIncarnationId,
          adapterId: 'codex',
          hitKind: 'rate-limit',
        },
      },
    });
    expect(fixture.tasks.list(fixture.mission.id)[0]).toMatchObject({
      status: 'done',
    });
    expect(
      registryMocks.requestMissionWorkerPaneRetirement,
    ).toHaveBeenCalledWith({
      paneId: fixture.paneId,
      sessionId: fixture.sessionId,
      missionId: fixture.mission.id,
      workerIncarnationId: fixture.claim.workerIncarnationId,
      scope: fixture.scope,
    });
    expect(driverMocks.requestMissionDriverTick).toHaveBeenCalled();
  });

  it('required task: terminates the exact stuck session, never marks success, no scheduler wake from the waiver lane', () => {
    const fixture = runningWorkerFixture({ executor: true });
    configureProviderFailureWaiver({ runtimeManager: fixture.runtime });

    const outcome = handleMissionWorkerProviderNoRoute(
      noRouteInputFor(fixture),
    );

    expect(outcome).toBe('retry');
    // Nada de sucesso sintético: o dispatch segue running e sem receipt; a
    // recuperação limitada existente (retry do failover + session-exit do
    // scheduler) decide o destino da task.
    expect(fixture.dispatches.get(fixture.task.id)).toMatchObject({
      state: 'running',
      integrationReceipt: undefined,
    });
    expect(fixture.tasks.list(fixture.mission.id)[0]).toMatchObject({
      status: 'running',
    });
    // Escolha documentada (requisito 10): o encerramento vai pela mesma
    // função authority-sealed do retirement (identidade exata re-provada pelo
    // registry); se for recusado, apenas o retry limitado permanece.
    expect(
      registryMocks.requestMissionWorkerPaneRetirement,
    ).toHaveBeenCalledWith({
      paneId: fixture.paneId,
      sessionId: fixture.sessionId,
      missionId: fixture.mission.id,
      workerIncarnationId: fixture.claim.workerIncarnationId,
      scope: fixture.scope,
    });
    expect(driverMocks.requestMissionDriverTick).not.toHaveBeenCalled();
  });

  it('keeps the limited retry when no exact dispatch exists or the runtime is not configured', () => {
    const fixture = runningWorkerFixture();
    configureProviderFailureWaiver({ runtimeManager: fixture.runtime });

    expect(
      handleMissionWorkerProviderNoRoute({
        ...noRouteInputFor(fixture),
        sessionId: 'session-desconhecida',
      }),
    ).toBe('retry');
    expect(
      registryMocks.requestMissionWorkerPaneRetirement,
    ).not.toHaveBeenCalled();
    expect(fixture.dispatches.get(fixture.task.id)?.state).toBe('running');

    configureProviderFailureWaiver({ runtimeManager: null });
    expect(
      handleMissionWorkerProviderNoRoute(noRouteInputFor(fixture)),
    ).toBe('retry');
    expect(fixture.dispatches.get(fixture.task.id)?.state).toBe('running');
  });
});
