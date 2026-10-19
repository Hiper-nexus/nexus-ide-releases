import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const mocks = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
  isProviderEnabled: vi.fn(() => true),
  providerReadiness: vi.fn(() => ({ ready: true, reason: 'ready' })),
  hasAvailableAccount: vi.fn(),
  quotaSnapshot: vi.fn((): unknown => null),
  classifyTaskWithSkillForRouting: vi.fn(async (_task: string): Promise<unknown> => ({ kind: 'skipped' })),
  // Espião do motor: passa a chamada para o routeTask real, só conta e lê os
  // argumentos (o contrafactual da regra é uma SEGUNDA chamada e não pode herdar
  // nada do Jev).
  routeTask: vi.fn(),
  probePreSpawn: vi.fn(async (_adapterId: string): Promise<unknown> => null),
}));

vi.mock('../pty/pre-spawn-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pty/pre-spawn-probe')>()),
  probePreSpawn: mocks.probePreSpawn,
}));

vi.mock('../persistence/provider-config-store', () => ({
  // F-1485: a rota aquece o cofre do Grok antes da prontidão síncrona.
  warmGrokAccountCredentialCache: () => {},
  sessionExpiredBeyondRenewal: () => false,
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

// Snapshot de cota dirigido por teste; null = sem leitura (fail-open).
vi.mock('../quota/quota-service', () => ({
  requireQuotaService: () => ({ lastSnapshot: mocks.quotaSnapshot }),
}));

vi.mock('./jev-task-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jev-task-routing')>()),
  classifyTaskWithSkillForRouting: mocks.classifyTaskWithSkillForRouting,
}));

vi.mock('./task-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-router')>();
  mocks.routeTask.mockImplementation(actual.routeTask);
  return { ...actual, routeTask: mocks.routeTask };
});

import { rememberKimiSeatReadiness } from '../adapters/seat-auth-readiness';
import { adapterCircuitBreakers } from './circuit-breaker';
import { isCliLimited, noteCliLimit, resetCliLimits } from './cli-limit-registry';
import { QUOTA_ENTRY_MAX_AGE_MS } from './quota-pace';
import {
  clearRecentCredentialProbeFailuresForTests,
  hasRecentCredentialProbeFailure,
  recordRecentCredentialProbeFailure,
} from '../pty/pre-spawn-probe';
import { buildDomainTools, routeTaskForCaller } from './tools-domain';
import { clearRouteProvenance, hasRecentRouteMatch } from './route-provenance';
import { clearRouteLog, recentRouteLog } from './route-log';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  configureProjectDomainStoreRegistry,
  disposeProjectDomainStoreRegistry,
} from './project-domain-store-registry';

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
  resetCliLimits();
  rememberKimiSeatReadiness('present');
  mocks.listProviderSettings.mockReset();
  mocks.isProviderEnabled.mockReset();
  mocks.isProviderEnabled.mockReturnValue(true);
  mocks.providerReadiness.mockReset();
  mocks.providerReadiness.mockReturnValue({ ready: true, reason: 'ready' });
  mocks.hasAvailableAccount.mockReset();
  mocks.hasAvailableAccount.mockReturnValue(true);
  mocks.quotaSnapshot.mockReset();
  mocks.quotaSnapshot.mockReturnValue(null);
  mocks.classifyTaskWithSkillForRouting.mockReset();
  mocks.classifyTaskWithSkillForRouting.mockResolvedValue({ kind: 'skipped' });
  mocks.routeTask.mockClear();
  mocks.probePreSpawn.mockReset();
  mocks.probePreSpawn.mockResolvedValue(null);
});

afterEach(() => {
  rememberKimiSeatReadiness(undefined);
});

describe('nexus_route_task wiring', () => {
  it('F-1316: classifica brief absoluto do prompt sem persistir seu conteúdo', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'routing-brief-')));
    const brief = path.join(dir, 'critical.md');
    const content = 'Corrigir autenticação e autorização de pagamentos. Faça com o GPT-6 Astra. API_KEY=sk-' + 'x'.repeat(32);
    fs.writeFileSync(brief, content);
    mocks.listProviderSettings.mockReturnValue([
      { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-6.1-sol', 'gpt-6-astra'] },
    ]);
    // Revisão Fable: o brief só é lido de dentro do projeto (ou userData/briefs).
    const inProject = { ...context(), scope: testProjectScope({ rootRealPath: dir }) };
    try {
      for (const internal of [false, true]) {
        const args = internal ? { task: 'Implementar unidade' } : { task: 'Implementar unidade', prompt: `Leia e siga ${brief}` };
        const decision = await routeTaskForCaller(args, inProject, internal ? { classificationPrompt: `Leia e siga ${brief}` } : {});
        expect(decision.tier).toBe('critical');
        expect(decision.model).not.toContain('astra');
        const classified = mocks.classifyTaskWithSkillForRouting.mock.calls.at(-1)?.[0];
        expect(classified).toContain('autenticação');
        expect(classified).not.toContain('sk-' + 'x'.repeat(32));
        expect(recentRouteLog()[0].taskPreview).not.toContain('autenticação');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F-1316 (revisão Fable): brief apontado fora do projeto não entra e o recibo diz por quê', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'routing-brief-')));
    const brief = path.join(dir, 'critical.md');
    fs.writeFileSync(brief, 'Corrigir autenticação e autorização de pagamentos.');
    mocks.listProviderSettings.mockReturnValue([
      { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-6.1-sol'] },
    ]);
    try {
      const decision = await routeTaskForCaller({ task: 'corrigir typo no README', prompt: `Leia ${brief}` }, context());
      expect(mocks.classifyTaskWithSkillForRouting.mock.calls.at(-1)?.[0]).toBe('corrigir typo no README');
      expect(decision.reason).toContain(`brief não lido: ${brief} (fora da raiz do projeto e de userData/briefs)`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a descrição não manda rotear antes de cada spawn: o spawn sem adapterId já roteia', () => {
    // Campo (02/10): "Call it for every delegation" levava o Maestro Codex a
    // gastar uma rodada inteira do modelo roteando 5 tarefas antes de abri-las.
    const description = tool('nexus_route_task').description;
    expect(description).not.toMatch(/every delegation/i);
    expect(description).toMatch(/do NOT need it to delegate/);
    expect(description).toMatch(/nexus_pane_spawn\(\{task, prompt\}\) without adapterId/);
  });

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

  it.each(['.claude/skills/api-review/SKILL.md', '.nexus/skills/api-review/SKILL.md'])(
    'preserva a skill de projeto %s quando a rota escolhe CLI sem superfície bundled',
    async (skillPath) => {
      mocks.listProviderSettings.mockReturnValue([
        { adapterId: 'muse', enabled: true, installed: true, authStrategy: 'oauth', models: ['muse-wonder-1.0'] },
      ]);
      mocks.classifyTaskWithSkillForRouting.mockResolvedValue({
        kind: 'unavailable',
        reason: 'invalid-answer',
        skillSuggestion: { name: 'api-review', pkg: 'project', path: skillPath, confidence: 0.9 },
      });

      const decision = await routeTaskForCaller({ task: 'tarefa de complexidade média' }, context());

      expect(decision.adapterId).toBe('muse');
      expect(decision.skillSuggestion).toEqual({
        name: 'api-review', pkg: 'project', path: skillPath, confidence: 0.9,
      });
    },
  );

  it('omite skill bundled quando a rota escolhe CLI sem sua superfície de entrega', async () => {
    mocks.listProviderSettings.mockReturnValue([
      { adapterId: 'muse', enabled: true, installed: true, authStrategy: 'oauth', models: ['muse-wonder-1.0'] },
    ]);
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue({
      kind: 'unavailable',
      reason: 'invalid-answer',
      skillSuggestion: { name: 'ponytail', pkg: 'ponytail', confidence: 0.9 },
    });

    const decision = await routeTaskForCaller({ task: 'tarefa de complexidade média' }, context());

    expect(decision.adapterId).toBe('muse');
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

  const fullKimiSnapshot = (usedRatio: number) => ({
    updatedAt: Date.now(),
    entries: [{
      id: 'kimi', adapterId: 'kimi', label: 'kimi', installed: true, onCooldown: false, updatedAt: Date.now(),
      windows: [{
        kind: 'weekly', label: 'Semanal', usedRatio, resetsAt: Date.now() + 86_400_000,
        source: 'provider-api', confidence: 'high',
      }],
    }],
  });

  it('conta com janela medida em 100% (sem cooldown) sai da rota', async () => {
    mocks.listProviderSettings.mockReturnValue([kimiProvider, codexProvider]);
    mocks.quotaSnapshot.mockReturnValue(fullKimiSnapshot(1));
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa de complexidade média' },
      context(),
    )) as { adapterId: string; alternatives: Array<{ adapterId: string }> };
    expect(decision.adapterId).toBe('codex');
    expect(decision.alternatives.map((a) => a.adapterId)).not.toContain('kimi');
  });

  it('a mesma CLI com folga na janela continua elegível', async () => {
    mocks.listProviderSettings.mockReturnValue([kimiProvider]);
    mocks.quotaSnapshot.mockReturnValue(fullKimiSnapshot(0.3));
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa de complexidade média' },
      context(),
    )) as { adapterId: string; reason: string };
    expect(decision.adapterId).toBe('kimi');
    expect(decision.reason).not.toMatch(/cooling/);
  });

  const routedIds = async () => {
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa de complexidade média' },
      context(),
    )) as { adapterId: string; alternatives: Array<{ adapterId: string }> };
    return [decision.adapterId, ...decision.alternatives.map((a) => a.adapterId)];
  };

  it('N4: leitura com mais de 15 min não exclui a CLI (o snapshot em memória não expira sozinho)', async () => {
    mocks.listProviderSettings.mockReturnValue([kimiProvider, codexProvider]);
    const snapshot = fullKimiSnapshot(1);
    snapshot.entries[0].updatedAt = Date.now() - QUOTA_ENTRY_MAX_AGE_MS - 60_000;
    mocks.quotaSnapshot.mockReturnValue(snapshot);
    expect(await routedIds()).toContain('kimi');
  });

  it('B1: janela por modelo a 100% ("Semanal (Fable)") não tira a CLI da rota', async () => {
    mocks.listProviderSettings.mockReturnValue([kimiProvider, codexProvider]);
    const snapshot = fullKimiSnapshot(0.3);
    snapshot.entries[0].windows.push({ ...snapshot.entries[0].windows[0], label: 'Semanal (Fable)', usedRatio: 1 });
    mocks.quotaSnapshot.mockReturnValue(snapshot);
    expect(await routedIds()).toContain('kimi');
  });

  it('fail-safe: janela cheia que esvaziaria a rota é revertida', async () => {
    mocks.listProviderSettings.mockReturnValue([kimiProvider]);
    mocks.quotaSnapshot.mockReturnValue(fullKimiSnapshot(1));
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa de complexidade média' },
      context(),
    )) as { adapterId: string; reason: string };
    expect(decision.adapterId).toBe('kimi');
    expect(decision.reason).toMatch(/cooling/);
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

// F-773 (G6): a decisão do nexus_route_task persiste no checkout e o
// nexus_route_log a devolve depois do restart, com quem disputou e perdeu.
describe('nexus_route_log persistente (F-773)', () => {
  let baseDir = '';
  let manager: ProjectRuntimeManager | null = null;

  const boot = () => {
    manager = new ProjectRuntimeManager({ baseDir, appVersion: 'f773-route-tools' });
    configureProjectDomainStoreRegistry(manager);
  };

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f773-route-tools-'));
    boot();
  });

  afterEach(() => {
    disposeProjectDomainStoreRegistry();
    manager?.closeAll();
    manager = null;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('a decisão sobrevive ao restart e o nexus_route_log lê do checkout', async () => {
    mocks.listProviderSettings.mockReturnValue([
      { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth', models: ['kimi-code/k3'] },
      { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-5.6-luna'] },
    ]);
    const decision = (await tool('nexus_route_task').handler(
      { task: 'tarefa de complexidade média' },
      context(),
    )) as { adapterId: string; reason: string; alternatives: Array<{ adapterId: string }> };

    // Restart: memória e registro somem; o banco do checkout fica.
    clearRouteLog();
    disposeProjectDomainStoreRegistry();
    manager?.closeAll();
    boot();

    const out = (await tool('nexus_route_log').handler({}, context())) as {
      decisions: Array<{ adapterId: string; reason: string; at?: number; alternatives?: Array<{ adapterId: string }> }>;
    };
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]).toMatchObject({ adapterId: decision.adapterId, reason: decision.reason });
    expect(out.decisions[0]!.at).toEqual(expect.any(Number));
    expect(out.decisions[0]!.alternatives?.map((alt) => alt.adapterId)).toEqual(
      decision.alternatives.map((alt) => alt.adapterId).slice(0, 12),
    );
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

  it('F-1471: troca de conta mantém o modelo do pane anterior quando a CLI o oferece; senão fica o da rota', async () => {
    mocks.listProviderSettings.mockReturnValue([
      { adapterId: 'glm', enabled: true, installed: true, authStrategy: 'oauth', models: ['glm-5.3', 'glm-5.2'] },
    ]);
    const base = (await routeTaskForCaller({ task: 'tarefa média' }, context())) as {
      adapterId: string; model: string;
    };
    expect(base.adapterId).toBe('glm');
    const kept = base.model === 'glm-5.3' ? 'glm-5.2' : 'glm-5.3';
    const decision = (await routeTaskForCaller({ task: 'tarefa média' }, context(), {
      preferModel: { adapterId: 'glm', model: kept },
    })) as { model: string; reason: string };
    expect(decision.model).toBe(kept);
    expect(decision.reason).toContain(`modelo do pane anterior mantido (${kept})`);
    // Modelo que a CLI não oferece (ou de outra CLI) não entra: a rota decide.
    const unknown = (await routeTaskForCaller({ task: 'tarefa média' }, context(), {
      preferModel: { adapterId: 'glm', model: 'glm-4-legacy' },
    })) as { model: string };
    expect(unknown.model).toBe(base.model);
    const otherCli = (await routeTaskForCaller({ task: 'tarefa média' }, context(), {
      preferModel: { adapterId: 'codex', model: kept },
    })) as { model: string };
    expect(otherCli.model).toBe(base.model);
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
  const museProvider = {
    adapterId: 'muse', enabled: true, installed: true,
    authStrategy: 'oauth', models: ['muse-spark-1.3'],
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

  // F-1410: o caso de campo de 12/10. O Muse Code tem login nativo por oauth —
  // não tem conta gerenciada, então `hasAvailableAccount` é true por construção
  // e a rota respondia "exclude ignorado (CLI saudável): muse … conta
  // disponível" logo depois de a conta do operador estourar. Com o limite
  // confirmado pela célula de status da própria TUI, a exclusão passa a valer.
  it('limite de uso confirmado tira a CLI da rota e honra o exclude do caller', async () => {
    mocks.listProviderSettings.mockReturnValue([museProvider, codexProvider]);
    // Reproduz o campo: disjuntor fechado (1 CLI sadia), sem morte na missão.
    mocks.hasAvailableAccount.mockReturnValue(true);
    try {
      noteCliLimit(
        'muse',
        {
          kind: 'rate-limit',
          reason: 'Usage limit reached',
          cooldownMs: 5 * 60 * 60 * 1000,
          adapterId: 'muse',
          confirmed: true,
        },
        Date.now(),
      );
      const decision = (await routeTaskForCaller(
        { task: 'tarefa média', exclude: ['muse'] },
        context(),
      )) as { adapterId: string; reason: string };

      expect(decision.adapterId).not.toBe('muse');
      expect(decision.reason).not.toContain('exclude ignorado');
      expect(decision.reason).toContain('exclude honrado (limite de uso confirmado): muse');
      expect(decision.reason).toContain('Usage limit reached');
      // A hora do reset sai no motivo — o Maestro sabe quando o Muse volta.
      expect(decision.reason).toMatch(/volta às \d{2}:\d{2}/);
      // A linha da CLI na mesa do roteador diz POR QUE saiu.
      const rows = mocks.routeTask.mock.calls.at(-1)?.[1] as Array<{
        id: string;
        installed: boolean;
        unavailableReason?: string;
      }>;
      expect(rows.find((row) => row.id === 'muse')).toMatchObject({
        installed: false,
        unavailableReason: 'limite de uso',
      });
    } finally {
      resetCliLimits();
    }
  });

  it('CLI com limite confirmado sai da rota mesmo SEM exclude do caller', async () => {
    mocks.listProviderSettings.mockReturnValue([museProvider, codexProvider]);
    try {
      noteCliLimit(
        'muse',
        { kind: 'rate-limit', reason: 'usage limited', cooldownMs: 5 * 60 * 60 * 1000, adapterId: 'muse', confirmed: true },
        Date.now(),
      );
      const decision = (await routeTaskForCaller(
        { task: 'tarefa média' },
        context(),
      )) as { adapterId: string; reason: string };
      expect(decision.adapterId).not.toBe('muse');
      expect(decision.reason).toContain('fora da rota (limite de uso confirmado): muse: usage limited');
    } finally {
      resetCliLimits();
    }
  });

  // Rota ≠ execução (16/10): a rota lia o muse como pronto, o gate pré-spawn
  // recusava a credencial e o assento caía no claude — 22 de 23 spawns, porque
  // a rota reescolhia o muse a cada pedido. A recusa recente o tira da rota.
  it('credencial recusada no spawn recente tira a CLI da rota, com motivo', async () => {
    mocks.listProviderSettings.mockReturnValue([museProvider, codexProvider]);
    recordRecentCredentialProbeFailure('muse');
    try {
      const decision = (await routeTaskForCaller(
        { task: 'tarefa média', preferAdapters: ['muse'] },
        context(),
      )) as { adapterId: string; reason: string };
      expect(decision.adapterId).not.toBe('muse');
      expect(decision.reason).toContain('fora da rota (credencial recusada no spawn recente): muse');
      const rows = mocks.routeTask.mock.calls.at(-1)?.[1] as Array<{
        id: string;
        installed: boolean;
        unavailableReason?: string;
      }>;
      expect(rows.find((row) => row.id === 'muse')).toMatchObject({
        installed: false,
        unavailableReason: 'credencial recusada no spawn',
      });
    } finally {
      clearRecentCredentialProbeFailuresForTests();
    }
  });

  // 18/10: o writer visual nasceu no muse e só o recibo SEGUINTE dizia que a
  // credencial dele foi recusada. A sonda roda na escolhida antes do recibo.
  it('credencial recusada pela sonda antes da escolha leva à próxima rota', async () => {
    mocks.listProviderSettings.mockReturnValue([museProvider, codexProvider]);
    mocks.probePreSpawn.mockImplementation(async (adapterId: string) =>
      adapterId === 'muse'
        ? { code: 'missing-credential', adapterId, hint: 'login' }
        : null,
    );
    try {
      const decision = (await routeTaskForCaller(
        { task: 'tarefa média', preferAdapters: ['muse'] },
        context(),
      )) as { adapterId: string; reason: string };
      expect(decision.adapterId).not.toBe('muse');
      expect(decision.reason).toContain('fora da rota (credencial recusada no spawn recente): muse');
      expect(mocks.probePreSpawn).toHaveBeenCalledWith('muse', expect.objectContaining({ silentRemint: true }));
      expect(hasRecentCredentialProbeFailure('muse')).toBe(true);
    } finally {
      clearRecentCredentialProbeFailuresForTests();
      adapterCircuitBreakers.reset('muse');
    }
  });

  it('recusas repetidas ficam fora após 10 min e só voltam quando o probe passa', async () => {
    mocks.listProviderSettings.mockReturnValue([museProvider, codexProvider]);
    const now = Date.now();
    recordRecentCredentialProbeFailure('muse', now - 20 * 60_000);
    recordRecentCredentialProbeFailure('muse', now - 15 * 60_000);
    mocks.probePreSpawn.mockImplementation(async (adapterId: string) =>
      adapterId === 'muse'
        ? { code: 'missing-credential', adapterId, hint: 'login' }
        : null,
    );
    try {
      const refused = (await routeTaskForCaller(
        { task: 'tarefa média', preferAdapters: ['muse'] }, context(),
      )) as { adapterId: string };
      expect(refused.adapterId).not.toBe('muse');
      expect(hasRecentCredentialProbeFailure('muse')).toBe(true);

      mocks.probePreSpawn.mockImplementation(async () => {
        clearRecentCredentialProbeFailuresForTests();
        return null;
      });
      const recovered = (await routeTaskForCaller(
        { task: 'tarefa média', preferAdapters: ['muse'] }, context(),
      )) as { adapterId: string };
      expect(mocks.probePreSpawn).toHaveBeenCalledWith('muse', expect.objectContaining({ silentRemint: true }));
      expect(recovered.adapterId).toBe('muse');
      expect(hasRecentCredentialProbeFailure('muse')).toBe(false);
    } finally {
      clearRecentCredentialProbeFailuresForTests();
      adapterCircuitBreakers.reset('muse');
    }
  });

  it('sem alternativa, a sonda recusada mantém a escolha para a cadeia do spawn', async () => {
    mocks.listProviderSettings.mockReturnValue([museProvider]);
    mocks.probePreSpawn.mockResolvedValue({ code: 'missing-credential', adapterId: 'muse', hint: 'login' });
    try {
      const decision = (await routeTaskForCaller({ task: 'tarefa média' }, context())) as { adapterId: string };
      expect(decision.adapterId).toBe('muse');
    } finally {
      clearRecentCredentialProbeFailuresForTests();
      adapterCircuitBreakers.reset('muse');
    }
  });

  it('a janela vencida devolve a CLI à rota', async () => {
    mocks.listProviderSettings.mockReturnValue([museProvider, codexProvider]);
    try {
      // Janela mínima: o registro expira sozinho e a rota volta a tratar o
      // exclude de muse como o de CLI saudável (ignorado, com aviso).
      noteCliLimit(
        'muse',
        { kind: 'rate-limit', reason: 'usage limited', cooldownMs: 1, adapterId: 'muse', confirmed: true },
        Date.now(),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(isCliLimited('muse')).toBe(false);
      const decision = (await routeTaskForCaller(
        { task: 'tarefa média', exclude: ['muse'] },
        context(),
      )) as { reason: string };
      expect(decision.reason).toContain('exclude ignorado (CLI saudável): muse');
    } finally {
      resetCliLimits();
    }
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

  // F-985 (missão 07/10): agy saiu antes do 1º turno ("nao-iniciou") e o
  // Maestro re-roteou com exclude: ["agy"] — a rota respondeu "exclude
  // ignorado (CLI saudável)" porque 1 falha de 3 deixa o disjuntor fechado.
  it('CLI que falhou ao nascer há pouco (disjuntor ainda fechado): o exclude é honrado', async () => {
    mocks.listProviderSettings.mockReturnValue([kimiProvider, codexProvider]);
    // O que o watchdog de início faz no pane que não iniciou (breaker 'count').
    adapterCircuitBreakers.recordFailure('kimi');
    try {
      expect(adapterCircuitBreakers.isOpen('kimi')).toBe(false);
      const decision = (await routeTaskForCaller(
        { task: 'tarefa média', exclude: ['kimi'] },
        context(),
      )) as { adapterId: string; reason: string };
      expect(decision.adapterId).toBe('codex');
      expect(decision.reason).not.toContain('exclude ignorado');
      expect(decision.reason).toContain(
        'exclude honrado (falhou ao nascer nos últimos 10 min): kimi',
      );
    } finally {
      adapterCircuitBreakers.reset('kimi');
    }
  });

  it('falha ao nascer seguida de início provado: a CLI volta a ser saudável', async () => {
    mocks.listProviderSettings.mockReturnValue([kimiProvider, codexProvider]);
    adapterCircuitBreakers.recordFailure('kimi');
    adapterCircuitBreakers.recordSuccess('kimi');
    try {
      const decision = (await routeTaskForCaller(
        { task: 'tarefa média', exclude: ['kimi'] },
        context(),
      )) as { adapterId: string; reason: string };
      expect(decision.adapterId).toBe('kimi');
      expect(decision.reason).toContain('exclude ignorado (CLI saudável): kimi');
    } finally {
      adapterCircuitBreakers.reset('kimi');
    }
  });

  it('falha ao nascer fora da janela de 10 min não torna a CLI doente', async () => {
    mocks.listProviderSettings.mockReturnValue([kimiProvider, codexProvider]);
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    adapterCircuitBreakers.recordFailure('kimi');
    now.mockReturnValue(t0 + 11 * 60_000);
    try {
      const decision = (await routeTaskForCaller(
        { task: 'tarefa média', exclude: ['kimi'] },
        context(),
      )) as { adapterId: string; reason: string };
      expect(decision.adapterId).toBe('kimi');
      expect(decision.reason).toContain('exclude ignorado (CLI saudável): kimi');
      expect(decision.reason).not.toContain('exclude honrado');
    } finally {
      now.mockRestore();
      adapterCircuitBreakers.reset('kimi');
    }
  });
});

describe('nexus_route_task — preferAdapters entre pares prontos (F-1313)', () => {
  // 'tarefa de complexidade média' classifica medium: glm-5.3 lidera o tier,
  // mimo-flash cola em benchmark oficial, longcat fica bem atrás.
  const providers = [
    { adapterId: 'glm', enabled: true, installed: true, authStrategy: 'oauth', models: ['glm-5.3', 'glm-5.2'] },
    { adapterId: 'mimo-code', enabled: true, installed: true, authStrategy: 'oauth', models: ['xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash'] },
    { adapterId: 'longcat', enabled: true, installed: true, authStrategy: 'apiKey', hasKey: true, models: ['LongCat-2.0'] },
    { adapterId: 'agy', enabled: true, installed: true, authStrategy: 'oauth', models: ['gemini-3.8-flash-high', 'gemini-3.7-flash'] },
  ];

  it('prefer decide entre líderes do mesmo tier', async () => {
    mocks.listProviderSettings.mockReturnValue(providers);
    const base = (await routeTaskForCaller({ task: 'tarefa de complexidade média' }, context())) as {
      adapterId: string;
    };
    const preferred = (await routeTaskForCaller(
      { task: 'tarefa de complexidade média', preferAdapters: ['mimo-code'] },
      context(),
    )) as { adapterId: string; reason: string };
    // Preferência explícita ganha entre candidatos prontos do mesmo tier.
    expect(preferred.adapterId).toBe('mimo-code');
    expect(preferred.adapterId).not.toBe(base.adapterId);
    expect(preferred.reason).toContain('mimo-code=preferido escolhido');
  });

  it('preferência explícita vence diferença de benchmark oficial no mesmo tier', async () => {
    mocks.listProviderSettings.mockReturnValue(providers);
    const decision = (await routeTaskForCaller(
      { task: 'tarefa de complexidade média', preferAdapters: ['longcat'] },
      context(),
    )) as { adapterId: string; reason: string };
    // O benchmark genérico não cancela a preferência do operador entre pares.
    expect(decision.adapterId).toBe('longcat');
    expect(decision.reason).toContain('longcat=preferido escolhido');
  });
});

describe('nexus_route_task — recibo: confiança do Jev e o que a regra teria escolhido', () => {
  // 'tarefa de complexidade média' classifica medium/general pela regra: o
  // glm-5.3 lidera. Com o Jev julgando "visual", a lane de topo (claude opus)
  // assume — a rota MUDA por causa do Jev, e o recibo precisa dizer isso.
  const providers = [
    { adapterId: 'claude', enabled: true, installed: true, authStrategy: 'oauth', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
    { adapterId: 'glm', enabled: true, installed: true, authStrategy: 'oauth', models: ['glm-5.3', 'glm-5.2'] },
    { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-5.6-luna'] },
  ];
  const TASK = 'tarefa de complexidade média';

  function jev(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'classified',
      classification: {
        tier: 'medium', tierConfidence: 0.9,
        specialty: 'visual', specialtyConfidence: 0.85,
        effort: 'medium', effortConfidence: 0.7,
        escalate: 0.1, model: 'jev-test',
        ...overrides,
      },
    };
  }

  type Receipt = {
    adapterId: string;
    model?: string;
    classifierSource: string;
    jevUnavailable?: string;
    confidence?: Record<string, number>;
    ruleChoice?: 'same' | { adapterId: string; model?: string; effort?: string };
  };

  async function route(args: Record<string, unknown> = { task: TASK }): Promise<Receipt> {
    return (await tool('nexus_route_task').handler(args, context())) as Receipt;
  }

  /** Argumentos de uma chamada ao routeTask: tier (4º) e contexto (7º). */
  function routerCall(index: number): { tier: unknown; ctx: Record<string, unknown> } {
    const call = mocks.routeTask.mock.calls[index] as unknown[];
    return { tier: call[3], ctx: call[6] as Record<string, unknown> };
  }

  beforeEach(() => {
    mocks.listProviderSettings.mockReturnValue(providers);
  });

  it('o Jev muda a rota: devolve a confiança aceita e o que a regra escolheria', async () => {
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue(jev());
    const decision = await route();

    expect(decision.classifierSource).toBe('jev');
    expect(decision.adapterId).toBe('claude');
    expect(decision.confidence).toEqual({ tier: 0.9, specialty: 0.85, effort: 0.7 });
    expect(decision.ruleChoice).not.toBe('same');
    expect(decision.ruleChoice).toMatchObject({ adapterId: 'glm', model: 'glm-5.3' });
  });

  it('o recálculo da regra NÃO herda tier/especialidade/esforço do Jev', async () => {
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue(jev({ tier: 'hard' }));
    await route();

    expect(mocks.routeTask).toHaveBeenCalledTimes(2);
    const withJev = routerCall(0);
    const byRule = routerCall(1);
    expect(withJev.tier).toBe('hard');
    expect(withJev.ctx).toMatchObject({ specialtyOverride: 'visual', effortOverride: 'medium' });
    expect(byRule.tier).toBeUndefined();
    expect(byRule.ctx.specialtyOverride).toBeUndefined();
    expect(byRule.ctx.effortOverride).toBeUndefined();
  });

  it('o tier do chamador vale nos dois lados (não é decisão do Jev)', async () => {
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue(jev());
    const decision = await route({ task: TASK, tier: 'easy' });

    expect(routerCall(0).tier).toBe('easy');
    expect(routerCall(1).tier).toBe('easy');
    expect(decision.confidence).toEqual({ specialty: 0.85, effort: 0.7 });
  });

  it('sem efeito colateral: uma única decisão registrada, a da regra nunca vira rota reconhecida', async () => {
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue(jev());
    const decision = await route();
    const rule = decision.ruleChoice as { adapterId: string; model?: string };

    expect(recentRouteLog()).toHaveLength(1);
    expect(recentRouteLog()[0]).toMatchObject({ adapterId: 'claude' });
    // O gate de spawn ad-hoc só reconhece o que foi ROTEADO de fato.
    expect(hasRecentRouteMatch('claude', 'claude-opus-5-5')).toBe(true);
    expect(hasRecentRouteMatch(rule.adapterId, rule.model)).toBe(false);
  });

  it('o Jev concorda com a regra: "same" (e a confiança continua no recibo)', async () => {
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue(jev({ specialty: 'general' }));
    const decision = await route();

    expect(decision.classifierSource).toBe('jev');
    expect(decision.ruleChoice).toBe('same');
    expect(decision.confidence).toMatchObject({ specialty: 0.85 });
  });

  it('só dimensão aceita ganha número: 0,59 cai para a heurística e some da confiança', async () => {
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue(jev({ tierConfidence: 0.59 }));
    const decision = await route();

    expect(decision.classifierSource).toBe('mixed');
    expect(decision.confidence).toEqual({ specialty: 0.85, effort: 0.7 });
    expect(decision.confidence).not.toHaveProperty('tier');
  });

  it.each([
    ['sem classificação (tarefa em branco)', { kind: 'skipped' }],
    ['Jev fora do ar', { kind: 'unavailable', reason: 'timeout' }],
    ['Jev pouco confiante em tudo', jev({ tierConfidence: 0.2, specialtyConfidence: 0.2, effortConfidence: 0.2 })],
  ])('%s: sem confiança, sem ruleChoice e sem recálculo', async (_label, batch) => {
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue(batch);
    const decision = await route();

    expect(decision.classifierSource).toBe('heuristic');
    expect(decision).not.toHaveProperty('confidence');
    expect(decision).not.toHaveProperty('ruleChoice');
    expect(mocks.routeTask).toHaveBeenCalledTimes(1);
  });

  it('Jev com todas as confianças < 0,6 marca jevUnavailable: low-confidence no recibo (F-1265)', async () => {
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue(
      jev({ tierConfidence: 0.2, specialtyConfidence: 0.2, effortConfidence: 0.2 }),
    );
    const decision = await route();
    expect(decision.classifierSource).toBe('heuristic');
    expect(decision.jevUnavailable).toBe('low-confidence');
  });

  it('fail-open: se o recálculo da regra lançar, a rota sai igual, só sem ruleChoice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue(jev());
    const real = mocks.routeTask.getMockImplementation()!;
    let calls = 0;
    // 1ª chamada (a rota com o Jev) é real; a 2ª (o contrafactual) quebra.
    mocks.routeTask.mockImplementation((...args: Parameters<typeof real>) => {
      calls += 1;
      if (calls === 2) throw new Error('boom');
      return real(...args);
    });
    try {
      const decision = await route();

      expect(decision.adapterId).toBe('claude');
      expect(decision.confidence).toEqual({ tier: 0.9, specialty: 0.85, effort: 0.7 });
      expect(decision).not.toHaveProperty('ruleChoice');
      expect(calls).toBe(2);
    } finally {
      mocks.routeTask.mockImplementation(real);
      warn.mockRestore();
    }
  });

  it('o diário de rotas guarda confiança e ruleChoice (só nomes e números)', async () => {
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue(jev());
    await route();

    expect(recentRouteLog()[0]).toMatchObject({
      classifierSource: 'jev',
      confidence: { tier: 0.9, specialty: 0.85, effort: 0.7 },
      ruleChoice: { adapterId: 'glm', model: 'glm-5.3' },
    });
  });

  it('privacidade: confiança e ruleChoice só têm ids e números, nunca o texto da tarefa', async () => {
    const sentinel = 'SEGREDO-CLIENTE-XYZ-123';
    mocks.classifyTaskWithSkillForRouting.mockResolvedValue(jev());
    const decision = await route({ task: `${TASK} ${sentinel}` });

    const receipt = JSON.stringify({ confidence: decision.confidence, ruleChoice: decision.ruleChoice });
    expect(receipt).not.toContain(sentinel);
    expect(decision.ruleChoice).not.toBe('same');
    for (const key of Object.keys(decision.ruleChoice as object)) {
      expect(['adapterId', 'model', 'effort']).toContain(key);
    }
    const logged = JSON.stringify({ c: recentRouteLog()[0].confidence, r: recentRouteLog()[0].ruleChoice });
    expect(logged).not.toContain(sentinel);
  });
});
