import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
  isProviderEnabled: vi.fn(() => true),
  providerReadiness: vi.fn(() => ({ ready: true, reason: 'ready' })),
  hasAvailableAccount: vi.fn(),
}));

vi.mock('../persistence/provider-config-store', () => ({
  listProviderSettings: mocks.listProviderSettings,
  isProviderEnabled: mocks.isProviderEnabled,
  providerReadiness: mocks.providerReadiness,
}));

// Real store underneath (untouched exports stay intact); only the spawn-gate
// predicate is driven per-test to simulate adapters fully on cooldown.
vi.mock('../persistence/account-store', async () => {
  const actual = await vi.importActual<typeof import('../persistence/account-store')>(
    '../persistence/account-store',
  );
  return { ...actual, hasAvailableAccount: mocks.hasAvailableAccount };
});

import { rememberKimiSeatReadiness } from '../adapters/seat-auth-readiness';
import { buildDomainTools } from './tools-domain';
import { clearRouteProvenance, hasRecentRouteMatch } from './route-provenance';
import { clearRouteLog, recentRouteLog } from './route-log';

const scope = testProjectScope();

function context(): AgentGateContext {
  return {
    token: 't',
    label: 'orch',
    role: 'orchestrator',
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function tool(name: string) {
  const found = buildDomainTools().find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeEach(() => {
  clearRouteProvenance();
  clearRouteLog();
  rememberKimiSeatReadiness('present');
  mocks.listProviderSettings.mockReset();
  mocks.isProviderEnabled.mockReset();
  mocks.isProviderEnabled.mockReturnValue(true);
  mocks.providerReadiness.mockReset();
  mocks.providerReadiness.mockReturnValue({ ready: true, reason: 'ready' });
  mocks.hasAvailableAccount.mockReset();
  mocks.hasAvailableAccount.mockReturnValue(true);
});

afterEach(() => {
  rememberKimiSeatReadiness(undefined);
});

describe('nexus_route_task wiring', () => {
  it('registra a decisão na proveniência E no route-log com o motivo', async () => {
    mocks.listProviderSettings.mockReturnValue([
      { adapterId: 'shell', enabled: true, installed: true, authStrategy: 'none', models: ['shell'] },
      { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth', models: ['kimi-code/k3'] },
      { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-5.5'] },
    ]);
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa de complexidade média' },
      context(),
    )) as { adapterId: string; model?: string; reason: string };

    expect(decision.adapterId).toBeTruthy();
    // Proveniência gravada: o pick é reconhecido pelo gate de spawn ad-hoc.
    expect(hasRecentRouteMatch(decision.adapterId, decision.model)).toBe(true);
    // Route-log gravado com o motivo (observabilidade).
    const log = recentRouteLog();
    expect(log[0]).toMatchObject({ adapterId: decision.adapterId });
    expect(log[0].reason).toBeTruthy();
  });

  it('lança quando não há adapter roteável', async () => {
    mocks.listProviderSettings.mockReturnValue([]);
    await expect(
      tool('nexus_route_task').handler({ task: 'x' }, context()),
    ).rejects.toThrow(/no installed adapters/);
  });
});

describe('nexus_route_task quota auto-exclude', () => {
  const kimiProvider = {
    adapterId: 'kimi',
    enabled: true,
    installed: true,
    authStrategy: 'oauth',
    models: ['kimi-code/k3'],
  };
  const codexProvider = {
    adapterId: 'codex',
    enabled: true,
    installed: true,
    authStrategy: 'oauth',
    models: ['gpt-5.5'],
  };

  it('adapter com todas as contas em cooldown some do ranked e das alternativas', async () => {
    mocks.listProviderSettings.mockReturnValue([kimiProvider, codexProvider]);
    const natural = (await tool('nexus_route_task').handler(
      { task: 'tarefa de complexidade média' },
      context(),
    )) as { adapterId: string };

    // Todas as contas do vencedor natural entram em cooldown → re-rota.
    mocks.hasAvailableAccount.mockImplementation(
      (id: string) => id !== natural.adapterId,
    );
    const rerouted = (await tool('nexus_route_task').handler(
      { task: 'tarefa de complexidade média' },
      context(),
    )) as { adapterId: string; alternatives: Array<{ adapterId: string }> };

    expect(rerouted.adapterId).not.toBe(natural.adapterId);
    expect(rerouted.alternatives.map((a) => a.adapterId)).not.toContain(
      natural.adapterId,
    );
  });

  it('fail-safe: auto-exclude que esvaziaria a rota é revertido e registrado no reason/log', async () => {
    mocks.listProviderSettings.mockReturnValue([kimiProvider]);
    mocks.hasAvailableAccount.mockReturnValue(false);
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa de complexidade média' },
      context(),
    )) as { adapterId: string; reason: string };

    // Sem o fail-safe não haveria candidato algum; com ele a rota volta e o
    // spawn enxerga o cooldown real da conta.
    expect(decision.adapterId).toBe('kimi');
    expect(decision.reason).toMatch(/cooling/);
    expect(recentRouteLog()[0].reason).toMatch(/cooling/);
  });
});

describe('nexus_route_log handler', () => {
  it('respeita o limit e clampa 0..50', async () => {
    mocks.listProviderSettings.mockReturnValue([
      { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth', models: ['kimi-code/k3'] },
    ]);
    for (let i = 0; i < 3; i += 1) {
      await tool('nexus_route_task').handler({ task: `t${i} media` }, context());
    }
    const out = (await tool('nexus_route_log').handler({ limit: 2 }, context())) as {
      decisions: unknown[];
    };
    expect(out.decisions.length).toBe(2);
    const all = (await tool('nexus_route_log').handler({}, context())) as {
      decisions: unknown[];
    };
    expect(all.decisions.length).toBe(3);
  });
});

describe('nexus_route_task first-wave AuthReadiness', () => {
  it('não senta Kimi quando AuthReadiness não é present', async () => {
    rememberKimiSeatReadiness('incomplete');
    mocks.listProviderSettings.mockReturnValue([
      {
        adapterId: 'kimi',
        enabled: true,
        installed: true,
        authStrategy: 'oauth',
        models: ['kimi-code/k3'],
      },
      {
        adapterId: 'codex',
        enabled: true,
        installed: true,
        authStrategy: 'oauth',
        models: ['gpt-5.5'],
      },
    ]);
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa de complexidade média' },
      context(),
    )) as { adapterId: string; alternatives: Array<{ adapterId: string }> };
    expect(decision.adapterId).toBe('codex');
    expect(decision.alternatives.map((row) => row.adapterId)).not.toContain(
      'kimi',
    );
  });
});

describe('nexus_clarify handler', () => {
  it('falha fechado fora de uma missão em vez de depender de prompt-hope', async () => {
    await expect(
      tool('nexus_clarify').handler(
        { question: 'Qual banco?', options: ['Postgres', 'MySQL'] },
        context(),
      ),
    ).rejects.toThrow(/missão|orquestrador/i);
  });

  it('propaga o erro de validação (menos de 2 opções)', async () => {
    await expect(
      tool('nexus_clarify').handler({ question: 'x', options: ['só uma'] }, context()),
    ).rejects.toThrow(/opç/i);
  });
});
