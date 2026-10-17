import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
  livePanes: [] as Array<Record<string, unknown>>,
  mission: {} as Record<string, unknown> | null,
  recorded: [] as Array<Record<string, unknown>>,
  claudeCapacity: vi.fn(() => 1),
  integrationState: { headSha: 'a'.repeat(40), treeDirty: false },
  reviewVerdict: null as Record<string, unknown> | null,
  consumedCounts: new Map<string, number>(),
}));

vi.mock('../persistence/provider-config-store', () => ({
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
    policy: { routableWorkerCliIds: new Set(['claude', 'codex', 'kimi']) },
  }),
}));

vi.mock('../adapters/adapter-registry', async (original) => ({
  ...(await original<typeof import('../adapters/adapter-registry')>()),
  listAdapters: () => [
    {
      id: 'claude',
      kind: 'cli-pty',
      bin: 'claude',
      quirks: { nexusMcp: 'autoload', mcpAutoload: true },
    },
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
      consumedRouteCountsByAdapterSince: () => h.consumedCounts,
    },
    missionPanes: { list: () => h.recorded },
  }),
}));

import {
  clearRouteProvenance,
  configureMissionlessPersistence,
  listDurableRouteUses,
  recordAgentSpawn,
} from './route-provenance';
import { routeTaskForCaller } from './tools-domain';

const ctx: AgentGateContext = {
  token: 't',
  label: 'mão do operador',
  role: 'orchestrator',
  sessionId: 'op',
  scope: testProjectScope(),
  allowedTools: null,
  allowedSkills: null,
  stopAttempts: 0,
  handoffSubmitted: false,
};

const TASK = 'tarefa média qualquer';
type Decision = { adapterId: string; reason: string };

async function route(context: AgentGateContext = ctx): Promise<Decision> {
  return (await routeTaskForCaller({ task: TASK, tier: 'medium' }, context)) as Decision;
}

describe('contador durável de uso e fair-share de rotas (F-232 / F-1291)', () => {
  let tmpDir: string;
  const file = () => path.join(tmpDir, 'missionless-route-uses.json');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-fair-share-'));
    configureMissionlessPersistence(tmpDir);
    clearRouteProvenance();
    h.mission = {};
    h.integrationState = { headSha: 'a'.repeat(40), treeDirty: false };
    h.reviewVerdict = null;
    h.recorded = [];
    h.livePanes = [];
    h.consumedCounts = new Map();
    h.claudeCapacity.mockReturnValue(1);
    h.listProviderSettings.mockReturnValue([
      {
        adapterId: 'claude',
        enabled: true,
        installed: true,
        authStrategy: 'oauth',
        models: ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1'],
      },
      {
        adapterId: 'codex',
        enabled: true,
        installed: true,
        authStrategy: 'oauth',
        models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'],
      },
      {
        adapterId: 'kimi',
        enabled: true,
        installed: true,
        authStrategy: 'oauth',
        models: ['kimi-code/k3'],
      },
    ]);
  });

  afterEach(() => {
    configureMissionlessPersistence(undefined);
    clearRouteProvenance();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('contagem sobrevive à exclusão da missão', async () => {
    // 1. Spawns ocorridos durante uma missão anterior
    const now = Date.now();
    recordAgentSpawn({ adapterId: 'claude', model: 'claude-sonnet-5-5', sessionId: 'sess-m1' }, now - 2000);
    recordAgentSpawn({ adapterId: 'claude', model: 'claude-sonnet-5-5', sessionId: 'sess-m2' }, now - 1000);

    // 2. A missão foi excluída do banco (SQLite ON DELETE CASCADE apagou as reservas),
    // portanto o store de reservas agora devolve 0/vazio para Claude:
    h.mission = null;
    h.consumedCounts = new Map();

    // 3. Ao rotear nova tarefa (ex: nova missão ou operador), o fair-share lê o contador durável
    const decision = await route();

    // Com 2 usos duráveis de claude e zero de codex/kimi, o fair-share troca para codex
    expect(decision.adapterId).not.toBe('claude');
    expect(decision.reason).toContain('fair-share');
  });

  it('spawn explícito de claude conta no fair-share', async () => {
    // Spawns manuais ou explícitos do operador de claude (não gerados por nexus_route_task)
    const now = Date.now();
    recordAgentSpawn({ adapterId: 'claude', model: 'claude-opus-5', sessionId: 'manual-1' }, now - 2000);
    recordAgentSpawn({ adapterId: 'claude', model: 'claude-opus-5', sessionId: 'manual-2' }, now - 1000);

    // O store de missões não tem nenhuma reserva registrada
    h.consumedCounts = new Map();

    // A próxima rota automática deve considerar os 2 spawns explícitos e ceder para codex
    const decision = await route();
    expect(decision.adapterId).toBe('codex');
    expect(decision.reason).toContain('fair-share');
  });

  it('janela 7d respeitada — usos além de 7 dias são desconsiderados', async () => {
    const now = Date.now();
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

    // Registra 5 spawns de claude há 8 dias (fora da janela de 7 dias)
    recordAgentSpawn({ adapterId: 'claude', model: 'claude-opus-5', sessionId: 'old-1' }, eightDaysAgo);
    recordAgentSpawn({ adapterId: 'claude', model: 'claude-opus-5', sessionId: 'old-2' }, eightDaysAgo + 100);
    recordAgentSpawn({ adapterId: 'claude', model: 'claude-opus-5', sessionId: 'old-3' }, eightDaysAgo + 200);

    // Na janela de 7 dias, claude tem 0 usos ativos -> claude é escolhido sem penalidade de fair-share
    const firstDecision = await route();
    expect(firstDecision.adapterId).toBe('claude');
    expect(firstDecision.reason).not.toContain('fair-share');

    // Agora registra 2 usos recentes de claude (dentro da janela de 7 dias)
    recordAgentSpawn({ adapterId: 'claude', model: 'claude-opus-5', sessionId: 'recent-1' }, now - 1000);
    recordAgentSpawn({ adapterId: 'claude', model: 'claude-opus-5', sessionId: 'recent-2' }, now - 500);

    // Com 2 usos na janela de 7 dias, o fair-share passa a vez para codex
    const secondDecision = await route();
    expect(secondDecision.adapterId).toBe('codex');
    expect(secondDecision.reason).toContain('fair-share');
  });

  it('fail-open — arquivo corrompido ou erro de persistência não quebra a rota', async () => {
    // Grava JSON corrompido no arquivo durável
    fs.writeFileSync(file(), '{ broken invalid json !!!');

    // A rota deve prosseguir normalmente sem lançar exceção
    const decision = await route();
    expect(decision).toBeDefined();
    expect(decision.adapterId).toBe('claude');
  });

  it('reinício do processo preserva histórico durável de spawns', async () => {
    const now = Date.now();
    recordAgentSpawn({ adapterId: 'claude', sessionId: 'persisted-1' }, now - 1000);
    recordAgentSpawn({ adapterId: 'claude', sessionId: 'persisted-2' }, now - 500);

    // Simula reinício do processo (limpando estado em memória e reconfigurando persistência)
    configureMissionlessPersistence(tmpDir);

    const uses = listDurableRouteUses();
    expect(uses).toHaveLength(2);
    expect(uses[0]?.sessionId).toBe('persisted-1');

    const decision = await route();
    expect(decision.adapterId).toBe('codex');
    expect(decision.reason).toContain('fair-share');
  });
});
