import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
  isProviderEnabled: vi.fn(() => true),
  providerReadiness: vi.fn(() => ({ ready: true, reason: 'ready' })),
  hasAvailableAccount: vi.fn(),
  classifyTaskWithSkillForRouting: vi.fn(async (): Promise<unknown> => ({ kind: 'skipped' })),
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

vi.mock('./jev-task-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jev-task-routing')>()),
  classifyTaskWithSkillForRouting: mocks.classifyTaskWithSkillForRouting,
}));

import { rememberKimiSeatReadiness } from '../adapters/seat-auth-readiness';
import { adapterCircuitBreakers } from './circuit-breaker';
import { buildDomainTools, routeTaskForCaller } from './tools-domain';
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
  mocks.classifyTaskWithSkillForRouting.mockReset();
  mocks.classifyTaskWithSkillForRouting.mockResolvedValue({ kind: 'skipped' });
});

afterEach(() => {
  rememberKimiSeatReadiness(undefined);
});

describe('nexus_route_task wiring', () => {
  it('registra a decisão na proveniência E no route-log com o motivo', async () => {
    mocks.listProviderSettings.mockReturnValue([
      { adapterId: 'shell', enabled: true, installed: true, authStrategy: 'none', models: ['shell'] },
      { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth', models: ['kimi-code/k3'] },
      { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-5.6-luna'] },
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

  it('devolve skillSuggestion do lote Jev e recebe o allowedSkills do chamador', async () => {
    mocks.listProviderSettings.mockReturnValue([
      { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-5.6-luna'] },
    ]);
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue({
      kind: 'unavailable',
      reason: 'disabled',
      skillSuggestion: { name: 'ponytail', pkg: 'ponytail', confidence: 0.9 },
    });
    const ctx = { ...context(), allowedSkills: ['ponytail'] };
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa de complexidade média' },
      ctx,
    )) as { skillSuggestion?: unknown };

    expect(mocks.classifyTaskWithSkillForRouting).toHaveBeenCalledWith(
      'tarefa de complexidade média',
      expect.objectContaining({ allowedSkills: ['ponytail'] }),
    );
    expect(decision.skillSuggestion).toEqual({ name: 'ponytail', pkg: 'ponytail', confidence: 0.9 });
  });

  it('skillSuggestion é null e fail-open quando o lote quebra', async () => {
    mocks.listProviderSettings.mockReturnValue([
      { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-5.6-luna'] },
    ]);
    mocks.classifyTaskWithSkillForRouting.mockRejectedValue(new Error('boom'));
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa de complexidade média' },
      context(),
    )) as { skillSuggestion?: unknown };
    expect(decision.skillSuggestion).toBeNull();
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
    models: ['gpt-5.6-luna'],
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
        models: ['gpt-5.6-luna'],
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

describe('nexus_route_task — Jev fora e desempate interno', () => {
  const providers = [
    { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth', models: ['kimi-code/k3'] },
    { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-5.6-luna'] },
  ];

  it('devolve jevUnavailable e grava origem + motivo no route log', async () => {
    mocks.listProviderSettings.mockReturnValue(providers);
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue({ kind: 'unavailable', reason: 'timeout' });
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa média' },
      context(),
    )) as Record<string, unknown>;
    expect(decision.jevUnavailable).toBe('timeout');
    expect(decision.classifierSource).toBe('heuristic');
    expect(recentRouteLog()[0]).toMatchObject({
      classifierSource: 'heuristic',
      jevUnavailable: 'timeout',
    });
  });

  it('Jev respondeu: sem jevUnavailable', async () => {
    mocks.listProviderSettings.mockReturnValue(providers);
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue({
      kind: 'classified',
      // Desde o F-163 o Jev também classifica o esforço; 'jev' exige as três
      // dimensões confiantes (sem esforço a origem honesta é 'mixed').
      classification: {
        tier: 'medium', tierConfidence: 0.9, specialty: 'feature',
        specialtyConfidence: 0.9, effort: 'medium', effortConfidence: 0.9,
        escalate: 0.1, model: 'jev-test',
      },
    });
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa média' },
      context(),
    )) as Record<string, unknown>;
    expect(decision.jevUnavailable).toBeUndefined();
    expect(decision.classifierSource).toBe('jev');
  });

  it('argumento MCP não injeta contagens; parâmetro interno sim', async () => {
    mocks.listProviderSettings.mockReturnValue(providers);
    const base = (await routeTaskForCaller({ task: 'tarefa média' }, context())) as {
      adapterId: string;
      alternatives: Array<{ adapterId: string }>;
    };
    const spoofed = (await tool('nexus_route_task').handler(
      { task: 'tarefa média', tieBreakUseCounts: { [base.adapterId]: 9 } },
      context(),
    )) as { adapterId: string };
    expect(spoofed.adapterId).toBe(base.adapterId);
    const internal = (await routeTaskForCaller({ task: 'tarefa média' }, context(), {
      tieBreakUseCounts: new Map([[base.adapterId, 1]]),
    })) as { adapterId: string; reason: string };
    // Pode ou não trocar (depende da margem real do catálogo); se trocar, o
    // motivo tem que dizer. Nunca pode escolher algo fora das alternativas.
    if (internal.adapterId !== base.adapterId) {
      expect(internal.reason).toContain('desempate');
      expect(base.alternatives.map((alt) => alt.adapterId)).toContain(internal.adapterId);
    }
  });

  it('exclusão interna do spawn pula adapter sem MCP e preserva candidato viável', async () => {
    mocks.listProviderSettings.mockReturnValue([
      { adapterId: 'agy', enabled: true, installed: true, authStrategy: 'oauth', models: ['gemini-3.8-flash-high'] },
      { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-5.6-luna'] },
    ]);
    const decision = await routeTaskForCaller(
      { task: 'tarefa média' },
      context(),
      { excludeAdapterIds: ['agy'] },
    );
    expect(decision.adapterId).toBe('codex');
  });
});

describe('nexus_route_task — exclude do caller só honra CLI doente', () => {
  const kimiProvider = {
    adapterId: 'kimi', enabled: true, installed: true,
    authStrategy: 'oauth', models: ['kimi-code/k3'],
  };
  const codexProvider = {
    adapterId: 'codex', enabled: true, installed: true,
    authStrategy: 'oauth', models: ['gpt-5.6-luna'],
  };

  it('exclusão de CLI saudável é ignorada e anotada no motivo', async () => {
    mocks.listProviderSettings.mockReturnValue([kimiProvider, codexProvider]);
    const decision = (await routeTaskForCaller(
      { task: 'tarefa média', exclude: ['kimi', 'grok'] },
      context(),
    )) as { adapterId: string; reason: string };

    // kimi está saudável (circuito fechado, conta disponível, sem mortes na
    // missão) — o pedido de exclusão não vale; grok nem instalado está e a
    // exclusão também é ignorada. O motivo diz quais foram descartadas.
    expect(decision.reason).toContain(
      'exclude ignorado (CLI saudável): kimi,grok',
    );
    expect(decision.adapterId).toBe('kimi');
  });

  it('circuit breaker aberto: a mesma exclusão passa a ser honrada', async () => {
    mocks.listProviderSettings.mockReturnValue([kimiProvider, codexProvider]);
    for (let i = 0; i < 3; i += 1) adapterCircuitBreakers.recordFailure('kimi');
    try {
      const decision = (await routeTaskForCaller(
        { task: 'tarefa média', exclude: ['kimi'] },
        context(),
      )) as { adapterId: string; reason: string };
      expect(decision.adapterId).toBe('codex');
      expect(decision.reason).not.toContain('exclude ignorado');
    } finally {
      adapterCircuitBreakers.reset('kimi');
    }
  });

  it('todas as contas em cooldown: a exclusão é honrada (e o auto-exclude também)', async () => {
    mocks.listProviderSettings.mockReturnValue([kimiProvider, codexProvider]);
    mocks.hasAvailableAccount.mockImplementation((id: string) => id !== 'kimi');
    const decision = (await routeTaskForCaller(
      { task: 'tarefa média', exclude: ['kimi'] },
      context(),
    )) as { adapterId: string; reason: string };
    expect(decision.adapterId).toBe('codex');
    expect(decision.reason).not.toContain('exclude ignorado');
  });
});

describe('nexus_route_task — preferAdapters é soft (uso geral)', () => {
  // 'tarefa de complexidade média' classifica medium: glm-5.3 lidera o tier,
  // mimo-flash cola em benchmark oficial, longcat fica bem atrás.
  const providers = [
    { adapterId: 'glm', enabled: true, installed: true, authStrategy: 'oauth', models: ['glm-5.3', 'glm-5.2'] },
    { adapterId: 'mimo-code', enabled: true, installed: true, authStrategy: 'oauth', models: ['xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash'] },
    { adapterId: 'longcat', enabled: true, installed: true, authStrategy: 'apiKey', hasKey: true, models: ['LongCat-2.0'] },
    { adapterId: 'agy', enabled: true, installed: true, authStrategy: 'oauth', models: ['gemini-3.8-flash-high', 'gemini-3.7-flash'] },
  ];

  it('prefer decide o near-tie entre líderes do mesmo tier', async () => {
    mocks.listProviderSettings.mockReturnValue(providers);
    const base = (await routeTaskForCaller({ task: 'tarefa de complexidade média' }, context())) as {
      adapterId: string;
    };
    const preferred = (await routeTaskForCaller(
      { task: 'tarefa de complexidade média', preferAdapters: ['mimo-code'] },
      context(),
    )) as { adapterId: string; reason: string };
    // O +4 do prefer vira o jogo entre glm-5.3 e mimo-flash (mesmo tier,
    // benchmark oficial quase igual) — mas nunca como prepend duro.
    expect(preferred.adapterId).toBe('mimo-code');
    expect(preferred.adapterId).not.toBe(base.adapterId);
    expect(preferred.reason).toContain('mimo-code=preferido escolhido');
  });

  it('prefer não derruba um candidato claramente melhor', async () => {
    mocks.listProviderSettings.mockReturnValue(providers);
    const decision = (await routeTaskForCaller(
      { task: 'tarefa de complexidade média', preferAdapters: ['longcat'] },
      context(),
    )) as { adapterId: string; reason: string };
    // LongCat-2.0 tem benchmark oficial fraco (TB2.1 70,8): mesmo com o +4 de
    // preferência fica atrás do glm-5.3 — soft, nunca pin.
    expect(decision.adapterId).toBe('glm');
    expect(decision.reason).toContain('longcat=preterido no multi-score');
  });
});
