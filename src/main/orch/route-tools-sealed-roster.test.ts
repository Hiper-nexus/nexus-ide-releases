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
import { testProjectScope } from './__tests__/scope-fixture';
import { encodeTaskScheduleDetail } from './mission-scheduler-meta';

const mocks = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
  hasAvailableAccount: vi.fn(),
  warmSquadRuntimeSubscriptionAuth: vi.fn(async () => {}),
}));

vi.mock('../persistence/provider-config-store', async () => {
  const actual = await vi.importActual<typeof import('../persistence/provider-config-store')>(
    '../persistence/provider-config-store',
  );
  return { ...actual, listProviderSettings: mocks.listProviderSettings };
});

vi.mock('../persistence/account-store', async () => {
  const actual = await vi.importActual<typeof import('../persistence/account-store')>(
    '../persistence/account-store',
  );
  return { ...actual, hasAvailableAccount: mocks.hasAvailableAccount };
});

// O warm toca Keychain; no teste o cache quente é irrelevante — o roster
// selado resolve sobre o snapshot de providers mockado acima.
vi.mock('./squad-runtime-inventory', async () => {
  const actual = await vi.importActual<typeof import('./squad-runtime-inventory')>(
    './squad-runtime-inventory',
  );
  return {
    ...actual,
    warmSquadRuntimeSubscriptionAuth: mocks.warmSquadRuntimeSubscriptionAuth,
  };
});

import { buildDomainTools } from './tools-domain';
import { clearRouteProvenance } from './route-provenance';
import { clearRouteLog, recentRouteLog } from './route-log';

const testDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nexus-route-sealed-roster-'),
);
const scope = testProjectScope({ rootRealPath: testDir });
let runtime: ProjectRuntimeManager;
let missionId = '';

const codexProvider = {
  adapterId: 'codex',
  enabled: true,
  installed: true,
  authStrategy: 'oauth',
  defaultModel: 'gpt-5.6-terra',
  models: ['gpt-5.6-terra'],
};
// GLM instalado e saudável: o roteamento livre o consideraria, mas o roster
// selado do plano amarra o executor ao Codex — glm nunca pode vazar.
const glmProvider = {
  adapterId: 'glm',
  enabled: true,
  installed: true,
  authStrategy: 'oauth',
  defaultModel: 'glm-5.2',
  models: ['glm-5.2'],
};

function context(): AgentGateContext {
  return {
    token: 'orch-sealed-route',
    sessionId: 'orch-sealed-route-session',
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

function adHocContext(): AgentGateContext {
  const ctx = context();
  delete ctx.missionId;
  return ctx;
}

function tool(name: string) {
  const found = buildDomainTools().find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeAll(() => {
  runtime = new ProjectRuntimeManager({
    baseDir: path.join(testDir, 'runtime'),
    appVersion: 'route-sealed-roster-test',
  });
  configureProjectDomainStoreRegistry(runtime);
  const base = compileIntentContract({ goal: 'Executar a missão', intentVersion: 1 });
  const mission = getProjectDomainStores(scope).missions.create({
    title: 'Sealed roster route',
    squadId: 'sealed-route-squad',
    intentState: 'dispatched',
    intentVersion: 1,
    orchestratorSessionId: 'orch-sealed-route-session',
    intentContract: {
      ...base,
      approvedAt: Date.now(),
      dispatchedAt: Date.now(),
    },
  });
  missionId = mission.id;
  getProjectDomainStores(scope).missions.setStatus(missionId, 'running');
  getProjectDomainStores(scope).tasks.createPlanAtomically({
    missionId,
    intentVersion: 1,
    squad: {
      id: 'sealed-route-squad',
      agents: [
        {
          id: 'maestro', agentName: 'Maestro', category: 'orchestrator',
          cli: 'codex', model: 'gpt-5.6-terra',
        },
        {
          id: 'builder', agentName: 'Builder', category: 'executor',
          cli: 'codex', model: 'gpt-5.6-terra', effort: 'high',
        },
      ],
    },
    rows: [{
      plannerId: 'managed',
      title: 'Implementar a correção',
      detail: encodeTaskScheduleDetail('Aplicar a correção aprovada.', {
        dependsOn: [],
        ownership: { files: ['src/managed.ts'], symbols: [], domains: [] },
        merged: false,
        agentRef: 'builder',
        agentCategory: 'executor',
        executionMode: 'isolated_worktree',
      }),
      agentRef: 'builder',
      agentCategory: 'executor',
    }],
  });
});

beforeEach(() => {
  clearRouteProvenance();
  clearRouteLog();
  mocks.listProviderSettings.mockReset();
  mocks.listProviderSettings.mockReturnValue([glmProvider, codexProvider]);
  mocks.hasAvailableAccount.mockReset();
  mocks.hasAvailableAccount.mockReturnValue(true);
  mocks.warmSquadRuntimeSubscriptionAuth.mockClear();
});

afterAll(() => {
  disposeProjectDomainStoreRegistry();
  runtime.closeAll();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('nexus_route_task com roster selado', () => {
  it('roteia pela cli/model do roster selado, nunca por adapter fora dele', async () => {
    const decision = (await tool('nexus_route_task').handler(
      { task: 'Implementar a correção' },
      context(),
    )) as {
      adapterId: string;
      model?: string;
      effort?: string;
      reason: string;
      alternatives: unknown[];
      routeReservationId?: string;
      routeReservationExpiresAt?: number;
    };

    expect(decision.adapterId).toBe('codex');
    expect(decision.model).toBe('gpt-5.6-terra');
    expect(decision.effort).toBe('high');
    expect(decision.reason).toContain(
      'roster selado: executor=codex/gpt-5.6-terra',
    );
    expect(decision.alternatives).toEqual([]);
    // A reserva fica persistida para o nexus_pane_spawn consumir.
    expect(decision.routeReservationId).toBeTruthy();
    expect(decision.routeReservationExpiresAt).toBeGreaterThan(Date.now());
    const persisted = getProjectDomainStores(scope).missions.getRouteReservation(
      decision.routeReservationId!,
    );
    expect(persisted?.decision.adapterId).toBe('codex');
    expect(recentRouteLog()[0]).toMatchObject({
      adapterId: 'codex',
      model: 'gpt-5.6-terra',
    });
  });

  it('casa a task pelo taskId planejado além do título', async () => {
    const planned = getProjectDomainStores(scope).tasks.listPlannedTasks(
      missionId,
      1,
    );
    expect(planned).toHaveLength(1);
    const decision = (await tool('nexus_route_task').handler(
      { task: planned[0]!.taskId },
      context(),
    )) as { adapterId: string; reason: string };

    expect(decision.adapterId).toBe('codex');
    expect(decision.reason).toContain('roster selado');
  });

  it('falha fechado quando a task não consta no plano selado', async () => {
    await expect(
      tool('nexus_route_task').handler(
        { task: 'Tarefa inventada fora do plano' },
        context(),
      ),
    ).rejects.toThrow(/roster_sealed_task_fora_do_plano/);
    // Nenhuma reserva órfã foi criada para a task fora do plano.
    expect(recentRouteLog()).toHaveLength(0);
  });

  it('sem missionId mantém o roteamento livre inalterado', async () => {
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa de complexidade média' },
      adHocContext(),
    )) as {
      adapterId: string;
      reason: string;
      routeReservationId?: string;
    };

    expect(['codex', 'glm']).toContain(decision.adapterId);
    // O que precisa ser provado é que NENHUM roster restringiu esta rota. Um
    // `not.toContain('roster selado')` cru reprovava a frase que diz
    // exatamente isso ("nenhum roster selado foi consultado"), porque casa com
    // o substring da negação. A asserção passa a exigir a negação explícita e
    // a ausência de qualquer alegação de roster aplicado.
    expect(decision.reason).toMatch(/nenhum roster selado foi consultado/i);
    expect(decision.reason).not.toMatch(/(?:conforme|segundo|pelo) roster selado/i);
    expect(decision.routeReservationId).toBeUndefined();
  });
});
