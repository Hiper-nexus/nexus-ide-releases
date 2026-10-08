import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

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
      consumedRouteCountsByAdapterSince: () => new Map(),
    },
    missionPanes: { list: () => h.recorded },
  }),
}));

import { routeTaskForCaller } from './tools-domain';

// Maestro em pane Claude, missão da aba — mesma ficha do teste de diversidade.
const ctx: AgentGateContext = {
  token: 't', label: 'orquestrador da aba', role: 'orchestrator', sessionId: 'orch',
  missionId: 'mission-tab', providerId: 'claude', scope: testProjectScope(),
  allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false,
};
// Tarefa crítica conhecida (task-router.test.ts): sem reserva o Claude lidera;
// reservado, a rota cai na melhor alternativa não-claude (codex).
const TASK = 'auditar a segurança da autenticação e dos pagamentos';

function livePane(paneId: string, adapterId: string) {
  return { paneId, sessionId: `s-${paneId}`, adapterId, state: 'busy', missionId: 'mission-tab' };
}

const TAB_MISSION = {
  id: 'mission-tab', status: 'running', title: 'Missão · Terminais',
  intentContract: { workspaceBinding: { version: 1, adoptedPaneId: 'pane-orch' } },
};

beforeEach(() => {
  h.mission = TAB_MISSION;
  h.integrationState = { headSha: 'a'.repeat(40), treeDirty: false };
  h.reviewVerdict = null;
  h.recorded = [{ paneId: 'pane-orch', adapterId: 'claude', role: 'orchestrator' }];
  h.livePanes = [livePane('pane-orch', 'claude')];
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

async function route() {
  return (await routeTaskForCaller({ task: TASK, preferAdapters: ['claude'] }, ctx)) as {
    adapterId: string;
    reason: string;
    alternatives: Array<{ adapterId: string }>;
  };
}

describe('F-235: capacidade de panes Claude por conta utilizável', () => {
  // F-985: a reserva é política de assentos — o recibo diz isso, nunca
  // "claude=não instalado" para o Claude que roda o próprio orquestrador.
  it('Maestro Claude + 1 conta: claude segue reservado, e o motivo diz que é reserva', async () => {
    const decision = await route();
    expect(decision.adapterId).not.toBe('claude');
    expect(decision.reason).not.toContain('claude=não instalado');
    expect(decision.reason).toContain(
      'claude=reservado: 1 pane(s) Claude vivo(s) nesta missão para 1 conta(s) Claude utilizável(is)',
    );
  });

  it('nenhuma conta Claude utilizável: reservado, sem dizer "não instalado"', async () => {
    h.claudeCapacity.mockReturnValue(0);
    const decision = await route();
    expect(decision.adapterId).not.toBe('claude');
    expect(decision.reason).not.toContain('claude=não instalado');
    expect(decision.reason).toContain('claude=reservado: nenhuma conta Claude utilizável');
  });

  it('Maestro Claude + 2 contas com credencial: um worker Claude é roteado', async () => {
    h.claudeCapacity.mockReturnValue(2);
    // Sem o codex, o Claude é o único candidato do tier crítico: reservado
    // ele cairia num tier emprestado (kimi), não reservado ele vence.
    h.listProviderSettings.mockReturnValue([
      { adapterId: 'claude', enabled: true, installed: true, authStrategy: 'oauth',
        models: ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1'] },
      { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth',
        models: ['kimi-code/k3'] },
    ]);
    const decision = await route();
    expect(decision.adapterId).toBe('claude');
    expect(decision.reason).not.toContain('claude=não instalado');
  });

  it('Maestro Claude + worker Claude vivo + 2 contas: reservado de novo', async () => {
    h.claudeCapacity.mockReturnValue(2);
    h.recorded = [
      { paneId: 'pane-orch', adapterId: 'claude', role: 'orchestrator' },
      { paneId: 'pane-w1', adapterId: 'claude', role: 'worker' },
    ];
    h.livePanes = [livePane('pane-orch', 'claude'), livePane('pane-w1', 'claude')];
    const decision = await route();
    expect(decision.adapterId).not.toBe('claude');
    expect(decision.reason).not.toContain('claude=não instalado');
    expect(decision.reason).toContain(
      'claude=reservado: 2 pane(s) Claude vivo(s) nesta missão para 2 conta(s) Claude utilizável(is)',
    );
  });

  // F-985: `mission_panes` guarda o worker depois que ele fecha (o worker de
  // missão fecha sozinho no handoff de sucesso). Contar a linha morta segurava
  // a conta e o Claude saía como "não instalado" até o fim da missão.
  it.each([
    ['fechado (fora da grade)', [] as Array<Record<string, unknown>>],
    ['exited na grade', [{ ...livePane('pane-w1', 'claude'), state: 'exited' }]],
  ])('worker Claude %s não segura assento: o Claude volta à rota', async (_label, deadWorker) => {
    h.claudeCapacity.mockReturnValue(2);
    h.listProviderSettings.mockReturnValue([
      { adapterId: 'claude', enabled: true, installed: true, authStrategy: 'oauth',
        models: ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1'] },
      { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth',
        models: ['kimi-code/k3'] },
    ]);
    h.recorded = [
      { paneId: 'pane-orch', adapterId: 'claude', role: 'orchestrator' },
      { paneId: 'pane-w1', adapterId: 'claude', role: 'worker' },
    ];
    h.livePanes = [livePane('pane-orch', 'claude'), ...deadWorker];
    const decision = await route();
    expect(decision.adapterId).toBe('claude');
    expect(decision.reason).not.toContain('claude=não instalado');
    expect(decision.reason).not.toContain('claude=reservado');
  });
});


describe('Main-bound reviewed finding cost escalation', () => {
  beforeEach(() => {
    // Kimi is economic but still needs real first-wave credential evidence.
    h.listProviderSettings.mockReturnValue(h.listProviderSettings().map((provider: Record<string, unknown>) =>
      provider.adapterId === 'kimi' ? { ...provider, hasKey: true } : provider));
  });
  const task = 'Corrija o achado src/main/orch/tool-util.ts:653 do segundo Enter';
  const proof = () => ({ missionId: 'mission-tab', headSha: 'a'.repeat(40), treeDirty: false,
    verdict: 'reject', frontier: true, findings: ['src/main/orch/tool-util.ts:653 segundo Enter suprimido'] });

  it('uses a current clean frontier finding recorded by Main to route its correction', async () => {
    h.claudeCapacity.mockReturnValue(2);
    h.reviewVerdict = proof();
    const decision = await routeTaskForCaller({ task, tier: 'hard' }, ctx);
    expect(decision.reason).toContain('purpose=finding-fix');
    expect(decision.adapterId).not.toBe('kimi');
  });

  it.each(['stale-head', 'dirty-review', 'dirty-current', 'not-frontier', 'unrelated-finding', 'caller-boolean'] as const)(
    '%s cannot prove a finding fix or force expensive routing', async (reason) => {
      h.claudeCapacity.mockReturnValue(2);
      h.reviewVerdict = proof();
      if (reason === 'stale-head') h.reviewVerdict.headSha = 'b'.repeat(40);
      if (reason === 'dirty-review') h.reviewVerdict.treeDirty = true;
      if (reason === 'dirty-current') h.integrationState.treeDirty = true;
      if (reason === 'not-frontier') h.reviewVerdict.frontier = false;
      if (reason === 'unrelated-finding') h.reviewVerdict.findings = ['src/main/orch/other.ts:10 outro achado'];
      if (reason === 'caller-boolean') h.reviewVerdict = null;
      const decision = await routeTaskForCaller({ task, tier: 'hard', reviewedFindingFix: true }, ctx);
      expect(decision.reason).toContain('purpose=writer');
      expect(decision.adapterId).toBe('kimi');
    },
  );
});
