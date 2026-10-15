import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
  getProjectDomainStores,
} from './project-domain-store-registry';
import { testProjectScope } from './__tests__/scope-fixture';
import type { JevRouteTaskBatch } from './jev-task-routing';

const mocks = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
  isProviderEnabled: vi.fn(() => true),
  providerReadiness: vi.fn(() => ({ ready: true, reason: 'ready' })),
  hasAvailableAccount: vi.fn(() => true),
  routableWorkerCliIds: new Set<string>(['codex']),
  classifyTaskWithSkillForRouting: vi.fn(async (): Promise<JevRouteTaskBatch> => ({ kind: 'skipped' })),
}));

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

vi.mock('./jev-task-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jev-task-routing')>()),
  classifyTaskWithSkillForRouting: mocks.classifyTaskWithSkillForRouting,
}));

vi.mock('../persistence/provider-config-store', () => ({
  // F-1485: a rota aquece o cofre do Grok antes da prontidão síncrona.
  warmGrokAccountCredentialCache: () => {},
  sessionExpiredBeyondRenewal: () => false,
  listProviderSettings: mocks.listProviderSettings,
  isProviderEnabled: mocks.isProviderEnabled,
  providerReadiness: mocks.providerReadiness,
}));
vi.mock('../persistence/account-store', async () => {
  const actual = await vi.importActual<typeof import('../persistence/account-store')>(
    '../persistence/account-store',
  );
  return { ...actual, hasAvailableAccount: mocks.hasAvailableAccount };
});
vi.mock('./squad-runtime-inventory', async () => {
  const actual = await vi.importActual<
    typeof import('./squad-runtime-inventory')
  >('./squad-runtime-inventory');
  return {
    ...actual,
    liveSquadRuntimeInventory: () => ({
      policy: { routableWorkerCliIds: mocks.routableWorkerCliIds },
    }),
  };
});

import { buildDomainTools } from './tools-domain';
import { suggestOperatorRoute } from './tools-panes';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-route-tool-store-'));
const scope = testProjectScope({ rootRealPath: testDir });
let runtime: ProjectRuntimeManager;
let missionId = '';

function context(): AgentGateContext {
  return {
    token: 'route-tool-token',
    sessionId: 'route-tool-session',
    label: 'Maestro',
    role: 'orchestrator',
    missionId,
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

beforeAll(() => {
  mocks.listProviderSettings.mockReturnValue([
    {
      adapterId: 'kimi',
      enabled: true,
      installed: true,
      authStrategy: 'oauth',
      models: ['kimi-code/kimi-for-coding'],
    },
    {
      adapterId: 'codex',
      enabled: true,
      installed: true,
      authStrategy: 'oauth',
      models: ['gpt-5.6-sol'],
    },
  ]);
  runtime = new ProjectRuntimeManager({
    baseDir: path.join(testDir, 'runtime'),
    appVersion: 'route-tool-reservation-test',
  });
  configureProjectDomainStoreRegistry(runtime);
  missionId = getProjectDomainStores(scope).missions.create({
    title: 'Persistir decisão do router',
    intentState: 'dispatched',
    intentVersion: 1,
    orchestratorSessionId: 'route-tool-session',
  }).id;
  getProjectDomainStores(scope).missions.setStatus(missionId, 'running');
});

afterAll(() => {
  disposeProjectDomainStoreRegistry();
  runtime.closeAll();
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('nexus_route_task RouteReservation durável', () => {
  it('a Main read-only suggestion does not reserve a phantom worker slot', async () => {
    const before = getProjectDomainStores(scope).missions.listOpenRouteAdapterIds(missionId);
    const route = await suggestOperatorRoute('Revisão independente de código', context(), { requireReadOnlyEnforceable: true });
    expect(route).toHaveProperty('adapterId');
    expect(route).not.toHaveProperty('routeReservationId');
    expect(getProjectDomainStores(scope).missions.listOpenRouteAdapterIds(missionId)).toEqual(before);
  });
  it.each([
    { effort: 'low' as const, confidence: 0.9, efforts: ['low', 'medium', 'high'], expected: 'low' },
    { effort: 'xhigh' as const, confidence: 0.9, efforts: ['low', 'medium', 'high'], expected: 'high' },
    { effort: 'xhigh' as const, confidence: 0.45, efforts: ['low', 'medium', 'high'], expected: 'high' },
    { effort: 'high' as const, confidence: 0.9, efforts: [], expected: undefined },
  ])('persists native effort $expected from Jev $effort at confidence $confidence', async ({ effort, confidence, efforts, expected }) => {
    mocks.classifyTaskWithSkillForRouting.mockResolvedValueOnce({ kind: 'classified', classification: {
      tier: 'hard', tierConfidence: 0.9, specialty: 'bug', specialtyConfidence: 0.9,
      effort, effortConfidence: confidence, escalate: 0.2, model: 'jev-test',
    } });
    const previousProviders = mocks.listProviderSettings();
    mocks.listProviderSettings.mockReturnValue([{
      adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth',
      models: ['gpt-5.6-sol'], efforts,
    }]);
    const routeTool = buildDomainTools().find((tool) => tool.name === 'nexus_route_task')!;
    try {
      const result = await routeTool.handler({ task: 'Diagnose the reported failure' }, context()) as {
        effort?: string; routeReservationId: string; reason: string;
      };
      expect(result.effort).toBe(expected);
      expect(result.reason).toContain(`source=${confidence >= 0.6 ? 'jev' : 'tier'}`);
      expect(getProjectDomainStores(scope).missions.getRouteReservation(result.routeReservationId)?.decision.effort).toBe(expected);
    } finally {
      mocks.listProviderSettings.mockReturnValue(previousProviders);
    }
  });

  it('reserva rota somente para o orquestrador, nunca para worker', async () => {
    const routeTool = buildDomainTools().find(
      (candidate) => candidate.name === 'nexus_route_task',
    )!;
    await expect(
      routeTool.handler(
        { task: 'tentar cunhar autoridade de spawn pelo worker' },
        { ...context(), role: 'worker' },
      ),
    ).rejects.toThrow(/orquestrador|orchestrator/i);
  });

  it('retorna id/expiração e persiste a decisão exata na missão', async () => {
    const routeTool = buildDomainTools().find(
      (candidate) => candidate.name === 'nexus_route_task',
    );
    if (!routeTool) throw new Error('nexus_route_task missing');

    const result = (await routeTool.handler(
      { task: 'implementar uma tarefa média no worker' },
      context(),
    )) as {
      adapterId: string;
      model?: string;
      effort?: string;
      routeReservationId: string;
      routeReservationExpiresAt: number;
    };

    expect(result.routeReservationId).toMatch(/^route-reservation-/);
    expect(result.routeReservationExpiresAt).toBeGreaterThan(Date.now());
    expect(result.adapterId).toBe('codex');
    expect(
      getProjectDomainStores(scope).missions.getRouteReservation(
        result.routeReservationId,
      ),
    ).toMatchObject({
      missionId,
      decision: {
        adapterId: result.adapterId,
        model: result.model,
        effort: result.effort,
      },
    });
  });

  it('falha com correção acionável quando nenhuma CLI do roster está disponível', async () => {
    const routeTool = buildDomainTools().find(
      (candidate) => candidate.name === 'nexus_route_task',
    )!;
    const previousRoute = getProjectDomainStores(scope).missions.get(
      missionId,
    )?.latestRoute;
    mocks.routableWorkerCliIds.clear();
    try {
      await expect(
        routeTool.handler(
          { task: 'delegar leitura a um worker Kimi' },
          context(),
        ),
      ).rejects.toThrow(
        /mission_worker_route_unavailable.*nenhuma CLI do roster.*Providers.*Nenhuma RouteReservation/is,
      );
    } finally {
      mocks.routableWorkerCliIds.add('codex');
    }

    expect(
      getProjectDomainStores(scope).missions.get(missionId)?.latestRoute,
    ).toEqual(previousRoute);
  });

  it('recusa cunhar reservation por uma sessão de orquestrador obsoleta', async () => {
    const routeTool = buildDomainTools().find(
      (candidate) => candidate.name === 'nexus_route_task',
    )!;
    await expect(
      routeTool.handler(
        { task: 'tentar rotear por uma sessão substituída' },
        { ...context(), sessionId: 'route-tool-session-stale' },
      ),
    ).rejects.toThrow(/orchestrator_session_stale/);
  });

  it('não permite que um orquestrador roteie em nome de outra missão', async () => {
    const routeTool = buildDomainTools().find(
      (candidate) => candidate.name === 'nexus_route_task',
    )!;
    await expect(
      routeTool.handler(
        { task: 'tarefa média', missionId: 'foreign-mission' },
        context(),
      ),
    ).rejects.toThrow(/child mission must match/i);
  });

  it('o contrafactual da regra não reserva nada: uma só reserva, com a decisão final do Jev', async () => {
    mocks.classifyTaskWithSkillForRouting.mockResolvedValueOnce({ kind: 'classified', classification: {
      tier: 'medium', tierConfidence: 0.9, specialty: 'feature', specialtyConfidence: 0.9,
      effort: 'high', effortConfidence: 0.9, escalate: 0.2, model: 'jev-test',
    } });
    const previousProviders = mocks.listProviderSettings();
    mocks.listProviderSettings.mockReturnValue([{
      adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth',
      models: ['gpt-5.6-sol'], efforts: ['low', 'medium', 'high'],
    }]);
    const missions = getProjectDomainStores(scope).missions;
    const openBefore = missions.listOpenRouteAdapterIds(missionId).length;
    const routeTool = buildDomainTools().find((tool) => tool.name === 'nexus_route_task')!;
    try {
      const result = await routeTool.handler({ task: 'implementar uma tarefa média no worker' }, context()) as {
        effort?: string;
        routeReservationId: string;
        confidence?: Record<string, number>;
        ruleChoice?: { adapterId: string; model?: string; effort?: string } | 'same';
      };
      // O Jev subiu o esforço: a regra (tier e esforço da heurística) fica abaixo.
      expect(result.effort).toBe('high');
      expect(result.confidence).toEqual({ tier: 0.9, specialty: 0.9, effort: 0.9 });
      expect(result.ruleChoice).toMatchObject({ adapterId: 'codex', model: 'gpt-5.6-sol' });
      expect((result.ruleChoice as { effort?: string }).effort).not.toBe('high');
      // Uma chamada, uma reserva — a escolha da regra nunca foi reservada.
      expect(missions.listOpenRouteAdapterIds(missionId)).toHaveLength(openBefore + 1);
      expect(missions.getRouteReservation(result.routeReservationId)?.decision).toMatchObject({
        adapterId: 'codex',
        effort: 'high',
      });
      expect(missions.getRouteReservation(result.routeReservationId)?.decision).not.toHaveProperty('ruleChoice');
    } finally {
      mocks.listProviderSettings.mockReturnValue(previousProviders);
    }
  });
});
