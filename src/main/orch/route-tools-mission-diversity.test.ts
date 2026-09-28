import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
  livePanes: [] as Array<Record<string, unknown>>,
  recorded: [] as Array<Record<string, unknown>>,
}));

vi.mock('../persistence/provider-config-store', () => ({
  listProviderSettings: h.listProviderSettings,
  isProviderEnabled: () => true,
  providerReadiness: () => ({ ready: true, reason: 'ready' }),
}));
vi.mock('../persistence/account-store', async () => ({
  ...(await vi.importActual<typeof import('../persistence/account-store')>(
    '../persistence/account-store',
  )),
  hasAvailableAccount: () => true,
}));
vi.mock('./jev-skill-suggestion', async (original) => ({
  ...(await original<typeof import('./jev-skill-suggestion')>()),
  suggestSkillForTask: async () => null,
}));
vi.mock('./jev-task-routing', async (original) => ({
  ...(await original<typeof import('./jev-task-routing')>()),
  classifyTaskForRouting: async () => ({ kind: 'skipped' }),
}));
vi.mock('./gate', async (original) => ({
  ...(await original<typeof import('./gate')>()),
  assertCurrentMissionOrchestratorSession: vi.fn(),
}));
vi.mock('./pane-registry', async (original) => ({
  ...(await original<typeof import('./pane-registry')>()),
  listPaneSnapshots: () => h.livePanes,
}));
vi.mock('./squad-runtime-inventory', async (original) => ({
  ...(await original<typeof import('./squad-runtime-inventory')>()),
  warmSquadRuntimeSubscriptionAuth: async () => undefined,
  liveSquadRuntimeInventory: () => ({
    policy: { routableWorkerCliIds: new Set(['agy', 'codex', 'kimi']) },
  }),
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    // Missão leve da aba (0.76.110): sem squad, running, só o orquestrador
    // registrado em mission_panes — os helpers nascem sem linha ali.
    missions: {
      get: () => ({ id: 'mission-tab', status: 'running', title: 'Missão · Terminais' }),
      listOpenRouteAdapterIds: () => [],
      reserveRouteDecision: () => ({ id: 'rr', expiresAt: 1 }),
    },
    missionPanes: { list: () => h.recorded },
  }),
}));

import { rememberKimiSeatReadiness } from '../adapters/seat-auth-readiness';
import { routeTaskForCaller } from './tools-domain';

const ctx: AgentGateContext = {
  token: 't', label: 'orquestrador da aba', role: 'orchestrator', sessionId: 'orch',
  missionId: 'mission-tab', scope: testProjectScope(),
  allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false,
};
const TASK = 'Revisor A2: mapear as telas de funil e contatos do app web (somente leitura)';

function livePane(paneId: string, adapterId: string) {
  return { paneId, sessionId: `s-${paneId}`, adapterId, state: 'busy', missionId: 'mission-tab' };
}

beforeEach(() => {
  rememberKimiSeatReadiness('present');
  h.recorded = [{ paneId: 'pane-orch', adapterId: 'claude', role: 'orchestrator' }];
  h.livePanes = [livePane('pane-orch', 'claude')];
  h.listProviderSettings.mockReturnValue([
    { adapterId: 'agy', enabled: true, installed: true, authStrategy: 'oauth', models: ['gemini-3.8-flash-high'] },
    { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-5.6-luna'] },
    { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth', models: ['kimi-code/k3'] },
  ]);
});

describe('rota de missão enxerga os helpers vivos (F-658)', () => {
  it('o helper vivo sem linha em mission_panes pesa na diversidade da próxima rota', async () => {
    // Campo 28/09: três helpers do "+ Pane" em sequência, todos na mesma CLI.
    const first = (await routeTaskForCaller({ task: TASK }, ctx)) as { adapterId: string };
    h.livePanes = [...h.livePanes, livePane('pane-2', first.adapterId)];

    const second = (await routeTaskForCaller({ task: TASK }, ctx)) as { adapterId: string };
    expect(second.adapterId).not.toBe(first.adapterId);

    h.livePanes = [...h.livePanes, livePane('pane-4', second.adapterId)];
    const third = (await routeTaskForCaller({ task: TASK }, ctx)) as { adapterId: string };
    expect(new Set([first.adapterId, second.adapterId, third.adapterId]).size).toBe(3);
  });

  it('não conta duas vezes o pane que já está em mission_panes, nem pane encerrado', async () => {
    const first = (await routeTaskForCaller({ task: TASK }, ctx)) as { adapterId: string };
    h.livePanes = [
      ...h.livePanes,
      { ...livePane('pane-9', first.adapterId), state: 'exited' },
      { ...livePane('pane-8', first.adapterId), missionId: 'outra-missao' },
    ];
    const again = (await routeTaskForCaller({ task: TASK }, ctx)) as { adapterId: string };
    expect(again.adapterId).toBe(first.adapterId);
  });
});
