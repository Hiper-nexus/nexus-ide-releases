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

const mocks = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
  hasAvailableAccount: vi.fn(() => true),
}));

vi.mock('../persistence/provider-config-store', () => ({
  listProviderSettings: mocks.listProviderSettings,
}));
vi.mock('../persistence/account-store', async () => {
  const actual = await vi.importActual<typeof import('../persistence/account-store')>(
    '../persistence/account-store',
  );
  return { ...actual, hasAvailableAccount: mocks.hasAvailableAccount };
});

import { buildDomainTools } from './tools-domain';

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
});
