import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
  livePanes: [] as Array<Record<string, unknown>>,
  mission: {} as Record<string, unknown>,
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
vi.mock('./jev-task-routing', async (original) => ({
  ...(await original<typeof import('./jev-task-routing')>()),
  classifyTaskWithSkillForRouting: async () => ({ kind: 'skipped' }),
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
// O registro real só carrega no boot; aqui ele tem as CLIs do cenário com o
// quirk de MCP dos builtins (agy.json declara nexusMcp none).
vi.mock('../adapters/adapter-registry', async (original) => ({
  ...(await original<typeof import('../adapters/adapter-registry')>()),
  listAdapters: () => [
    { id: 'agy', kind: 'cli-pty', quirks: { nexusMcp: 'none' } },
    { id: 'codex', kind: 'cli-pty', quirks: { nexusMcp: 'codex' } },
    { id: 'kimi', kind: 'cli-pty', quirks: { nexusMcp: 'kimi' } },
  ],
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    // Missão leve da aba (0.76.110): sem squad, running, só o orquestrador
    // registrado em mission_panes — os helpers nascem sem linha ali.
    missions: {
      get: () => h.mission,
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

const TAB_MISSION = {
  id: 'mission-tab', status: 'running', title: 'Missão · Terminais',
  intentContract: { workspaceBinding: { version: 1, adoptedPaneId: 'pane-orch' } },
};

beforeEach(() => {
  rememberKimiSeatReadiness('present');
  h.mission = TAB_MISSION;
  h.recorded = [{ paneId: 'pane-orch', adapterId: 'claude', role: 'orchestrator' }];
  h.livePanes = [livePane('pane-orch', 'claude')];
  h.listProviderSettings.mockReturnValue([
    { adapterId: 'agy', enabled: true, installed: true, authStrategy: 'oauth', models: ['gemini-3.8-flash-high'] },
    { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-5.6-luna'] },
    { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth', models: ['kimi-code/k3'] },
  ]);
});

async function threeRoutes(): Promise<string[]> {
  const picked: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const route = (await routeTaskForCaller({ task: TASK }, ctx)) as { adapterId: string };
    picked.push(route.adapterId);
    h.livePanes = [...h.livePanes, livePane(`pane-h${i}`, route.adapterId)];
  }
  return picked;
}

describe('rota de missão enxerga os helpers vivos (F-658)', () => {
  it('o helper vivo sem linha em mission_panes pesa na diversidade da próxima rota', async () => {
    // Campo 28/09: três helpers do "+ Pane" em sequência, todos na mesma CLI.
    // Missão com squad: aqui a rota ainda aceita CLI sem MCP (entrega pelo PTY).
    h.mission = { ...TAB_MISSION, squadId: 'nexus-fullstack' };
    const picked = await threeRoutes();
    expect(new Set(picked).size).toBe(3);
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

describe('missão da aba só roteia para CLI com MCP do Nexus (F-662)', () => {
  it('o orquestrador retomado (sem promotedFromUserSession) nunca recebe o AGY', async () => {
    // Campo 28/09 10:05: depois do reinício o orquestrador da aba pediu rota
    // pelo nexus_route_task e recebeu o AGY, mudo no --print.
    expect(ctx.promotedFromUserSession).toBeUndefined();
    const picked = await threeRoutes();
    expect(picked).not.toContain('agy');
    expect(new Set(picked)).toEqual(new Set(['codex', 'kimi']));
  });
});
