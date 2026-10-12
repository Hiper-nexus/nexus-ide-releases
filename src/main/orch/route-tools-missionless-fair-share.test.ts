import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

// F-1291: o fair-share global lia só reservas consumidas (que só nascem com
// missionId) — spawn do operador sem missão nunca gravava nada e o roteador
// repetia a mesma CLI para sempre. Estes testes provam a memória de rotas sem
// missão alimentando o fair-share; o store continua vazio (sem reservas).
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
    policy: { routableWorkerCliIds: new Set(['claude', 'codex', 'kimi']) },
  }),
}));
vi.mock('../adapters/adapter-registry', async (original) => ({
  ...(await original<typeof import('../adapters/adapter-registry')>()),
  listAdapters: () => [
    { id: 'claude', kind: 'cli-pty', bin: 'claude',
      quirks: { nexusMcp: 'autoload', mcpAutoload: true } },
    { id: 'codex', kind: 'cli-pty', quirks: { nexusMcp: 'codex' } },
    { id: 'kimi', kind: 'cli-pty', quirks: { nexusMcp: 'kimi' } },
  ],
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      get: () => h.mission,
      reviewVerdicts: { latestFor: () => h.reviewVerdict },
      listOpenRouteAdapterIds: () => [],
      reserveRouteDecision: () => ({ id: 'rr', expiresAt: 1 }),
      // Sem missão não há reserva: o store nunca conta nada aqui.
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
const TASK = 'tarefa média qualquer';

type Decision = { adapterId: string; reason: string };

async function route(): Promise<Decision> {
  return (await routeTaskForCaller({ task: TASK, tier: 'medium' }, ctx)) as Decision;
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
      models: ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1'] },
    { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth',
      models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'] },
    { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth',
      models: ['kimi-code/k3'] },
  ]);
});

describe('fair-share sem missão (F-1291)', () => {
  it('rotas seguidas sem missão acumulam uso e o fair-share troca de CLI', async () => {
    const first = await route();
    const second = await route();
    // Gap anti-pingue-pongue: com 1 uso o líder se mantém.
    expect(second.adapterId).toBe(first.adapterId);
    expect(second.reason).not.toContain('fair-share');
    const third = await route();
    // Com 2 usos e alternativa zerada, o menos usado assume.
    expect(third.adapterId).not.toBe(first.adapterId);
    expect(third.reason).toContain('fair-share');
  });

  it('sugestão do hook (suggestOnly) não conta como uso', async () => {
    await routeTaskForCaller({ task: TASK, tier: 'medium' }, ctx, { suggestOnly: true });
    await routeTaskForCaller({ task: TASK, tier: 'medium' }, ctx, { suggestOnly: true });
    const after = await route();
    // Nada foi decidido de verdade: comporta-se como primeira rota.
    expect(after.reason).not.toContain('fair-share');
  });
});
