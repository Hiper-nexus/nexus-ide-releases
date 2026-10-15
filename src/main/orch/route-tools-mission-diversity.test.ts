import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
  livePanes: [] as Array<Record<string, unknown>>,
  mission: {} as Record<string, unknown>,
  routeOutcomes: [] as Array<Record<string, unknown>>,
  recorded: [] as Array<Record<string, unknown>>,
}));

vi.mock('../persistence/provider-config-store', () => ({
  // F-1485: a rota aquece o cofre do Grok antes da prontidão síncrona.
  warmGrokAccountCredentialCache: () => {},
  sessionExpiredBeyondRenewal: () => false,
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
    handoffs: { routeOutcomeCountsSince: () => h.routeOutcomes },
  }),
}));

import { rememberKimiSeatReadiness } from '../adapters/seat-auth-readiness';
import { routeTaskForCaller } from './tools-domain';
import {
  recordWorkerDeathWithoutDelivery,
  resetMissionWorkerMortality,
} from './worker-mortality';
import { noteMissionCliFailure, resetMissionCliFailures } from './mission-cli-failures';

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
  h.routeOutcomes = [];
  resetMissionCliFailures();
  h.mission = TAB_MISSION;
  h.recorded = [{ paneId: 'pane-orch', adapterId: 'claude', role: 'orchestrator' }];
  h.livePanes = [livePane('pane-orch', 'claude')];
  h.listProviderSettings.mockReturnValue([
    { adapterId: 'agy', enabled: true, installed: true, authStrategy: 'oauth', models: ['gemini-3.8-flash-high'] },
    { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-6.1-sol'] },
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
    // F-1400 ADD2: front reparte só entre assentos do pool; AGY não é assento visual.
    expect(new Set(picked)).toEqual(new Set(['codex', 'kimi']));
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

describe('exclude do caller só honra CLI doente (uso geral)', () => {
  it('adapter que morreu sem entregar na missão: a exclusão vale', async () => {
    // F-662 já tira o agy (sem MCP do Nexus) desta missão da aba — sobram
    // codex e kimi. Com uma morte sem entrega registrada, excluir kimi é
    // honrado; excluir o codex saudável seria ignorado.
    recordWorkerDeathWithoutDelivery('mission-tab', 'kimi');
    try {
      const dead = (await routeTaskForCaller(
        { task: TASK, exclude: ['kimi'] },
        ctx,
      )) as { adapterId: string; reason: string };
      expect(dead.adapterId).not.toBe('kimi');
      expect(dead.reason).not.toContain('exclude ignorado');
    } finally {
      resetMissionWorkerMortality('mission-tab');
    }
  });

  it('CLI saudável não sai da rota só porque o caller pediu', async () => {
    const healthy = (await routeTaskForCaller(
      { task: TASK, exclude: ['codex'] },
      ctx,
    )) as { adapterId: string; reason: string };
    expect(healthy.reason).toContain(
      'exclude ignorado (CLI saudável): codex',
    );
    // codex continua elegível: está no ranked e pode até ser o escolhido.
  });
});

// F-1427 (13/10): o MiMo travou >1 h, o MiniMax caiu num erro do provedor, o
// Maestro fechou os dois panes (nexus_pane_close, sem handoff) e pediu
// exclude: ["mimo-code","minimax-code"] — a rota respondeu "exclude ignorado
// (CLI saudável) … sem morte nesta missão" e escolheu o MiMo de novo.
describe('F-1427: falha da CLI nesta missão honra o exclude e entra no sucesso 14d', () => {
  it('pane fechado sem entrega depois de receber a tarefa: o exclude do Maestro vale', async () => {
    noteMissionCliFailure({
      missionId: 'mission-tab', adapterId: 'kimi', cause: 'closed-without-delivery', attemptKey: 'pane-kimi',
    });
    const route = (await routeTaskForCaller({ task: TASK, exclude: ['kimi'] }, ctx)) as {
      adapterId: string; reason: string;
    };
    expect(route.adapterId).not.toBe('kimi');
    expect(route.reason).not.toContain('exclude ignorado');
    expect(route.reason).toContain('exclude honrado (falhou nesta missão): kimi (fechado sem entrega)');
  });

  it('erro do provedor e reabertura por falta de prova também contam; falha de outra missão não', async () => {
    noteMissionCliFailure({
      missionId: 'mission-tab', adapterId: 'kimi', cause: 'provider-error', attemptKey: 'pane-a',
    });
    noteMissionCliFailure({
      missionId: 'outra-missao', adapterId: 'codex', cause: 'no-execution-proof', attemptKey: 'pane-b',
    });
    const route = (await routeTaskForCaller({ task: TASK, exclude: ['kimi', 'codex'] }, ctx)) as {
      reason: string;
    };
    expect(route.reason).toContain('exclude honrado (falhou nesta missão): kimi (erro do provedor)');
    expect(route.reason).toContain('exclude ignorado (CLI saudável): codex');
  });

  it('a falha entra como amostra failed no sucesso 14d da rota', async () => {
    // 5 entregas limpas do kimi no banco; a falha do pane fechado puxa a taxa.
    h.routeOutcomes = [{ adapterId: 'kimi', successes: 5, total: 5 }];
    const before = (await routeTaskForCaller({ task: TASK }, ctx)) as { reason: string };
    expect(before.reason).toMatch(/sucesso 14d: [^;]*kimi[^;]*1,00 \(5, CLI\)/);
    noteMissionCliFailure({
      missionId: 'mission-tab', adapterId: 'kimi', cause: 'closed-without-delivery', attemptKey: 'pane-kimi',
    });
    const after = (await routeTaskForCaller({ task: TASK }, ctx)) as { reason: string };
    expect(after.reason).toMatch(/sucesso 14d: [^;]*kimi[^;]*0,83 \(6, CLI\)/);
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
