import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileIntentContract } from '../../shared/mission-intent';
import type { AgentGateContext } from './gate';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  getProjectDomainStores,
} from './project-domain-store-registry';
import { clearRouteProvenance } from './route-provenance';
import { paneSpawnTool } from './tools-panes';
import { testProjectScope } from './__tests__/scope-fixture';
import { encodeTaskScheduleDetail } from './mission-scheduler-meta';

const squadMocks = vi.hoisted(() => {
  const squad = {
    id: 'route-test-squad',
    name: 'Route Test Squad',
    createdAt: '1',
    builtin: false,
    orchestratorInstructions: '',
    agents: [
      {
        id: 'maestro',
        agentName: 'Maestro',
        category: 'orchestrator',
        cli: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
      {
        id: 'builder',
        agentName: 'Builder',
        category: 'executor',
        cli: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
    ],
  };
  return {
    findAgentInSquad: vi.fn((squadId: string, ref: string) => {
      if (squadId !== squad.id) return null;
      const matches = squad.agents.filter(
        (agent) => agent.id === ref || agent.agentName === ref,
      );
      return matches.length === 1 ? { squad, agent: matches[0] } : null;
    }),
  };
});

vi.mock('./squad-store', async () => {
  const actual = await vi.importActual<typeof import('./squad-store')>(
    './squad-store',
  );
  return { ...actual, findAgentInSquad: squadMocks.findAgentInSquad };
});

const testDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nexus-route-reservation-'),
);
const scope = testProjectScope({ rootRealPath: testDir });
let runtime: ProjectRuntimeManager;
let missionId = '';

function context(): AgentGateContext {
  return {
    token: 'orch-route-reservation',
    sessionId: 'orch-route-reservation-session',
    label: 'orch',
    role: 'orchestrator',
    missionId,
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

async function spawnError(args: Record<string, unknown>): Promise<string> {
  try {
    await paneSpawnTool.handler(args, context());
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function reserveRoute(overrides: Partial<{
  adapterId: string;
  model: string;
  effort: string;
}> = {}) {
  const decision = {
    tier: 'medium' as const,
    adapterId: overrides.adapterId ?? 'grok',
    model: overrides.model ?? 'grok-4.1',
    effort: overrides.effort ?? 'medium',
    reason: 'rota de teste persistida antes do spawn',
    alternatives: [],
  };
  return getProjectDomainStores(scope).missions.reserveRouteDecision(
    missionId,
    'delegar tarefa de teste',
    decision,
  );
}

beforeAll(() => {
  runtime = new ProjectRuntimeManager({
    baseDir: path.join(testDir, 'runtime'),
    appVersion: 'route-reservation-test',
  });
  configureProjectDomainStoreRegistry(runtime);
  const base = compileIntentContract({ goal: 'Delegar a tarefa', intentVersion: 1 });
  const mission = getProjectDomainStores(scope).missions.create({
    title: 'Route reservation',
    squadId: 'route-test-squad',
    intentState: 'dispatched',
    intentVersion: 1,
    orchestratorSessionId: 'orch-route-reservation-session',
    intentContract: {
      ...base,
      approvedAt: Date.now(),
      dispatchedAt: Date.now(),
    },
  });
  missionId = mission.id;
  getProjectDomainStores(scope).missions.setStatus(missionId, 'running');
});

beforeEach(() => clearRouteProvenance());

afterAll(() => {
  disposeProjectDomainStoreRegistry();
  runtime.closeAll();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('RouteReservation enforced no nexus_pane_spawn (RC3)', () => {
  it('recusa materializar um segundo orquestrador pelo pane_spawn genérico', async () => {
    const message = await spawnError({ agentName: 'Maestro' });

    expect(message).toContain('orchestrator_spawn_forbidden');
    expect(message).toMatch(/main/i);
  });

  it('recusa delegação por uma sessão de orquestrador obsoleta', async () => {
    let message = '';
    try {
      await paneSpawnTool.handler(
        { agentName: 'Builder' },
        { ...context(), sessionId: 'stale-orchestrator-session' },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('orchestrator_session_stale');
  });

  it('mantém o roster sticky de executor para a sessão main-owned atual', async () => {
    const message = await spawnError({ agentName: 'Builder' });

    expect(message).not.toContain('orchestrator_spawn_forbidden');
    expect(message).not.toContain('orchestrator_session_stale');
    expect(message).not.toContain('route_reservation_required');
  });

  it('mantém o bloqueio de worker tentando virar orquestrador', async () => {
    let message = '';
    try {
      await paneSpawnTool.handler(
        { agentName: 'Maestro' },
        { ...context(), role: 'worker' },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/workers cannot create orchestrators/i);
  });

  it('recusa consumir reservation sem sessão PTY vinculada e nunca usa o bearer como identidade', async () => {
    const reservation = reserveRoute();
    const unbound = context();
    delete unbound.sessionId;
    // Exercita isoladamente o gate da própria reserva em uma linha legada sem
    // binding de orquestrador. Missões modernas falham ainda antes no fence de
    // sessão main-owned, coberto pelo teste acima.
    getProjectDomainStores(scope).missions.setOrchestratorSession(missionId, null);

    let message = '';
    try {
      await paneSpawnTool.handler({
        adapterId: 'grok',
        model: 'grok-4.1',
        effort: 'medium',
        routeReservationId: reservation.id,
      }, unbound);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      getProjectDomainStores(scope).missions.setOrchestratorSession(
        missionId,
        'orch-route-reservation-session',
      );
    }

    expect(message).toContain('route_reservation_session_required');
    const persisted = getProjectDomainStores(scope).missions.getRouteReservation(
      reservation.id,
    );
    expect(persisted?.consumedAt).toBeUndefined();
    expect(persisted?.consumedBySession).toBeUndefined();
  });

  it('recusa spawn ad-hoc em missão running sem reservation válida', async () => {
    const message = await spawnError({
      adapterId: 'grok',
      model: 'grok-4.1',
      effort: 'medium',
    });

    expect(message).toContain('route_reservation_required');
    expect(message).toContain('nexus_route_task');
  });

  it('aceita a tuple exata da reserva e só então alcança o próximo gate', async () => {
    const reservation = reserveRoute();
    const message = await spawnError({
      adapterId: 'grok',
      model: 'grok-4.1',
      effort: 'medium',
      routeReservationId: reservation.id,
    });

    expect(message).toContain('context workflow service is not initialized');
    expect(message).not.toContain('route_reservation_');
    // Falhou antes do spawn real: a reserva continua disponível para retry.
    expect(
      getProjectDomainStores(scope).missions.getRouteReservation(reservation.id)
        ?.consumedAt,
    ).toBeUndefined();
  });

  it('recusa adapter/model/effort divergente da decisão reservada', async () => {
    const reservation = reserveRoute();
    const message = await spawnError({
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      routeReservationId: reservation.id,
    });

    expect(message).toContain('route_reservation_invalid');
    expect(message).toMatch(/adapter\/model\/effort/i);
  });

  it('recusa reserva já consumida em vez de autorizar um segundo spawn', async () => {
    const reservation = reserveRoute();
    const expected = {
      reservationId: reservation.id,
      missionId,
      adapterId: 'grok',
      model: 'grok-4.1',
      effort: 'medium',
    };
    getProjectDomainStores(scope).missions.consumeRouteReservation(
      expected,
      'first-spawn-session',
    );

    const message = await spawnError({
      adapterId: 'grok',
      model: 'grok-4.1',
      effort: 'medium',
      routeReservationId: reservation.id,
    });

    expect(message).toContain('route_reservation_invalid');
    expect(message).toMatch(/já foi consumida/i);
  });

  it('depois do plano durável recusa até spawn com reservation: só o main despacha', async () => {
    getProjectDomainStores(scope).tasks.createPlanAtomically({
      missionId,
      intentVersion: 1,
      squad: {
        id: 'route-test-squad',
        agents: [{
          id: 'worker', agentName: 'Worker', category: 'executor',
          cli: 'codex', model: 'gpt-5.6-sol',
        }],
      },
      rows: [{
        plannerId: 'managed',
        title: 'Task gerenciada pelo dispatcher',
        detail: encodeTaskScheduleDetail('Execute pelo main.', {
          dependsOn: [],
          ownership: { files: ['src/managed.ts'], symbols: [], domains: [] },
          merged: false,
          agentRef: 'worker',
          agentCategory: 'executor',
          executionMode: 'isolated_worktree',
        }),
        agentRef: 'worker',
        agentCategory: 'executor',
      }],
    });
    const reservation = reserveRoute();
    const message = await spawnError({
      adapterId: 'grok',
      model: 'grok-4.1',
      effort: 'medium',
      routeReservationId: reservation.id,
      taskId: 'manual-task',
    });

    expect(message).toContain('task_dispatcher_authority');
    expect(message).toMatch(/dispatcher durável/i);
    expect(
      getProjectDomainStores(scope).missions.getRouteReservation(reservation.id)
        ?.consumedAt,
    ).toBeUndefined();
  });
});
