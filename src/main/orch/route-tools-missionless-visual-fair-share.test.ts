import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

// F-1400 (parte 2): o revezamento visual por modelo (Opus/Sonnet/Wonder Full/
// Kimi/Sol) precisa valer também SEM missão. A memória de rotas sem missão só
// gravava adapter — Opus e Sonnet nunca se distinguiam e o primeiro assento do
// pool repetia para sempre. Estes testes provam que decisões visuais sem missão
// alimentam `visual:adapter:model` e distribuem os cinco assentos.
const h = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
  livePanes: [] as Array<Record<string, unknown>>,
  mission: {} as Record<string, unknown>,
  recorded: [] as Array<Record<string, unknown>>,
  claudeCapacity: vi.fn(() => 1),
  integrationState: { headSha: 'a'.repeat(40), treeDirty: false },
  reviewVerdict: null as Record<string, unknown> | null,
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
  countAccountsWithLiveCredential: (adapterId: string) =>
    adapterId === 'claude' ? h.claudeCapacity() : 0,
}));
vi.mock('./integration-review-gate', async (original) => ({
  ...(await original<typeof import('./integration-review-gate')>()),
  measureIntegrationStateAsync: async () => h.integrationState,
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
    policy: { routableWorkerCliIds: new Set(['claude', 'codex', 'kimi', 'muse', 'devin']) },
  }),
}));
// Kimi só é assento de primeira onda quando `kimi provider list` foi sondado
// como oauth (present); sem o mock o assento cai como 'incomplete' e sai do pool.
vi.mock('../adapters/seat-auth-readiness', async (original) => ({
  ...(await original<typeof import('../adapters/seat-auth-readiness')>()),
  peekKimiSeatReadiness: () => 'present',
}));
vi.mock('../adapters/adapter-registry', async (original) => ({
  ...(await original<typeof import('../adapters/adapter-registry')>()),
  listAdapters: () => [
    { id: 'claude', kind: 'cli-pty', bin: 'claude',
      quirks: { nexusMcp: 'autoload', mcpAutoload: true } },
    { id: 'codex', kind: 'cli-pty', quirks: { nexusMcp: 'codex' } },
    { id: 'kimi', kind: 'cli-pty', quirks: { nexusMcp: 'kimi' } },
    { id: 'muse', kind: 'cli-pty', quirks: { nexusMcp: 'muse' } },
    { id: 'devin', kind: 'cli-pty', quirks: { nexusMcp: 'devin' } },
  ],
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      get: () => h.mission,
      reviewVerdicts: { latestFor: () => h.reviewVerdict },
      listOpenRouteAdapterIds: () => [],
      reserveRouteDecision: () => ({ id: 'rr', expiresAt: 1 }),
      // Sem missão não há reserva: o store nunca conta nada aqui — a memória
      // de rotas sem missão é a única fonte dos contadores visuais.
      consumedRouteCountsByAdapterSince: () => new Map(),
    },
    missionPanes: { list: () => h.recorded },
  }),
}));

import { clearRouteProvenance } from './route-provenance';
import { routeTaskForCaller } from './tools-domain';

// Mão do operador: sem missão, sem filhos vivos, sem provider próprio.
const ctx: AgentGateContext = {
  token: 't', label: 'mão do operador', role: 'orchestrator', sessionId: 'op',
  scope: testProjectScope(),
  allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false,
};

const VISUAL_TASK = 'implementar a tela responsiva de cadastro com estados vazios';

type Decision = { adapterId: string; model?: string; effort?: string; reason: string };

async function route(task = VISUAL_TASK): Promise<Decision> {
  return (await routeTaskForCaller({ task, tier: 'medium' }, ctx)) as Decision;
}

beforeEach(() => {
  clearRouteProvenance();
  h.mission = {};
  h.integrationState = { headSha: 'a'.repeat(40), treeDirty: false };
  h.reviewVerdict = null;
  h.recorded = [];
  h.livePanes = [];
  h.claudeCapacity.mockReturnValue(1);
  h.listProviderSettings.mockReturnValue([
    { adapterId: 'claude', enabled: true, installed: true, authStrategy: 'oauth',
      models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
    { adapterId: 'muse', enabled: true, installed: true, authStrategy: 'oauth',
      models: ['muse-wonder-full-1.0'] },
    { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth',
      models: ['gpt-6.1-sol'] },
    { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth',
      models: ['kimi-code/k3'] },
  ]);
});

describe('revezamento visual sem missão (F-1400 parte 2)', () => {
  it('cinco tarefas visuais sem missão distribuem cinco assentos do pool', async () => {
    const picks: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const decision = await route();
      picks.push(`${decision.adapterId}:${decision.model}`);
    }
    expect(picks).toEqual([
      'claude:claude-opus-5-5',
      'claude:claude-sonnet-5-5',
      'muse:muse-wonder-full-1.0',
      'kimi:kimi-code/k3',
      'codex:gpt-6.1-sol',
    ]);
  });

  it('Devin SWE-2 (pedido do operador): seis tarefas visuais sem missão dão assento ao Devin', async () => {
    h.listProviderSettings.mockReturnValue([
      ...h.listProviderSettings(),
      { adapterId: 'devin', enabled: true, installed: true, authStrategy: 'oauth',
        models: ['swe-2-high', 'swe-2-medium'] },
    ]);
    const picks: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const decision = await route();
      picks.push(`${decision.adapterId}:${decision.model}`);
    }
    expect(picks).toContain('devin:swe-2-high');
    expect(new Set(picks).size).toBe(6);
  });

  it('Next.js continua Opus max sem missão, mesmo com uso visual recente alto', async () => {
    // Ocupa o Opus primeiro para provar que a regra do operador vence o uso.
    await route();
    const decision = await route('criar landing em Next.js');
    expect(decision).toMatchObject({
      adapterId: 'claude',
      model: 'claude-opus-5-5',
      effort: 'max',
    });
    expect(decision.reason).toContain('Next/jogo → Opus 5.5 (regra do operador)');
  });
});
