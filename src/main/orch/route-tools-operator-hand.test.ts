import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRouteProvenance } from './route-provenance';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

// F-802 — a rota AUTOMÁTICA do "+ Pane" (mão do operador, sem missão): as
// mesmas condições da missão valem para o helper aberto ali. O cenário imita o
// que `nexus_pane_spawn` sem adapterId faz: pede a rota com as contagens de
// uso do próprio pai (operatorChildUseCounts) e abre um pane na CLI escolhida.

const h = vi.hoisted(() => ({
  listProviderSettings: vi.fn(),
  livePanes: [] as Array<Record<string, unknown>>,
  globalUse: new Map<string, number>(),
  benchmark: { schemaVersion: 1, source: 'nexus-benchmark/unpublished', specialties: {} } as Record<string, unknown>,
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
vi.mock('./pane-registry', async (original) => ({
  ...(await original<typeof import('./pane-registry')>()),
  listPaneSnapshots: () => h.livePanes,
}));
vi.mock('./specialty-benchmark', async (original) => ({
  ...(await original<typeof import('./specialty-benchmark')>()),
  loadSpecialtyBenchmark: () => h.benchmark,
}));
// Os manifestos REAIS dos builtins: capacidade (webSearch), MCP e confinamento
// read-only vêm do código de produção, não de um duplo escrito à mão.
vi.mock('../adapters/adapter-registry', async (original) => {
  const actual = await original<typeof import('../adapters/adapter-registry')>();
  const { BUILTIN_ADAPTERS } = await import('../../adapters/builtin');
  const { adapterSchema } = await import('../../shared/adapter-types');
  const adapters = BUILTIN_ADAPTERS.map((raw) => adapterSchema.parse(raw));
  return {
    ...actual,
    listAdapters: () => adapters,
    getAdapter: (id: string) => adapters.find((adapter) => adapter.id === id) ?? null,
  };
});
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: {
      get: () => null,
      consumedRouteCountsByAdapterSince: () => new Map(h.globalUse),
      listOpenRouteAdapterIds: () => [],
    },
    missionPanes: { list: () => [] },
  }),
}));

import { rememberKimiSeatReadiness } from '../adapters/seat-auth-readiness';
import { GROK_FRONTIER_MODEL } from '../../shared/model-defaults';
import { routeTaskForCaller } from './tools-domain';
import { operatorChildUseCounts } from './operator-spawn-route';

const ctx: AgentGateContext = {
  token: 't', label: '+ Pane', role: 'user', sessionId: 'pane-op', providerId: 'claude',
  scope: testProjectScope(),
  allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false,
};

const MEDIUM_TASK = 'Implementar a paginação do endpoint de contatos com cursor e cobrir com testes unitários';

interface Route {
  adapterId: string;
  model?: string;
  reason: string;
}

function livePane(paneId: string, adapterId: string) {
  return { paneId, sessionId: `s-${paneId}`, adapterId, state: 'busy' };
}

/** O que o spawn passa ao resolver: as CLIs que o pai (e ele mesmo) já usam. */
async function routeLikeSpawn(
  task: string,
  internal: Record<string, unknown> = {},
): Promise<Route> {
  const tieBreakUseCounts = operatorChildUseCounts(
    ctx.sessionId,
    ctx.providerId,
    h.livePanes as never,
    (sessionId) => (sessionId.startsWith('s-helper') ? ctx.sessionId : undefined),
  );
  return (await routeTaskForCaller({ task }, ctx, { tieBreakUseCounts, ...internal })) as unknown as Route;
}

beforeEach(() => {
  // F-1291: a memória de rotas sem missão é estado do módulo; sem limpar, um
  // caso herda as rotas dos anteriores no fair-share.
  clearRouteProvenance();
  rememberKimiSeatReadiness('present');
  h.globalUse = new Map();
  h.benchmark = { schemaVersion: 1, source: 'nexus-benchmark/unpublished', specialties: {} };
  h.livePanes = [livePane('pane-op', 'claude')];
  h.listProviderSettings.mockReturnValue([
    { adapterId: 'claude', enabled: true, installed: true, authStrategy: 'oauth', models: ['claude-sonnet-5-5', 'claude-haiku-4-5'] },
    { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-6-luna'] },
    { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth', models: ['kimi-code/k3'] },
    { adapterId: 'agy', enabled: true, installed: true, authStrategy: 'oauth', models: ['gemini-3.8-flash-medium', 'gemini-3.8-flash-low'] },
    { adapterId: 'grok', enabled: true, installed: true, authStrategy: 'oauth', models: [GROK_FRONTIER_MODEL] },
  ]);
});

describe('"+ Pane": diversidade da rota (como na missão)', () => {
  it('helpers de implementação esgotam os três writers econômicos antes de repetir sem gastar Grok', async () => {
    const picked: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const route = await routeLikeSpawn(MEDIUM_TASK);
      picked.push(route.adapterId);
      h.livePanes = [...h.livePanes, livePane(`pane-helper${i}`, route.adapterId)];
      h.livePanes[h.livePanes.length - 1] = { ...h.livePanes[h.livePanes.length - 1], sessionId: `s-helper${i}` };
    }
    // The parent occupies Claude; the economic pool is Codex/Kimi/AGY.
    expect(new Set(picked.slice(0, 3)).size).toBe(3);
    expect(picked).not.toContain('grok');
    expect(picked).not.toContain('claude');
  });

  it('a rotação garantida aparece no motivo quando o líder já tem assento', async () => {
    const first = await routeLikeSpawn(MEDIUM_TASK);
    h.livePanes = [...h.livePanes, { ...livePane('pane-helper0', first.adapterId), sessionId: 's-helper0' }];
    const second = await routeLikeSpawn(MEDIUM_TASK);
    expect(second.adapterId).not.toBe(first.adapterId);
  });
});

describe('"+ Pane": fair-share dos últimos 7 dias (F-232)', () => {
  it('a CLI que concentrou o uso global cede a vez à menos usada', async () => {
    const cold = await routeLikeSpawn(MEDIUM_TASK);
    h.globalUse = new Map([
      [cold.adapterId, 12],
      ['claude', 12], ['codex', 12], ['kimi', 12], ['agy', 12], ['grok', 12],
      // Fair-share is retained within the economic implementation pool.
      [[ 'codex', 'kimi', 'agy' ].find(id => id !== cold.adapterId)!, 0],
    ]);
    h.globalUse.set(cold.adapterId, 12);
    const balanced = await routeLikeSpawn(MEDIUM_TASK);
    expect(balanced.adapterId).not.toBe(cold.adapterId);
    expect(balanced.reason).toContain('fair-share');
  });
});

describe('"+ Pane": capacidade exigida pela tarefa', () => {
  it('pesquisa na web nunca vai para CLI sem busca declarada', async () => {
    const route = await routeLikeSpawn(
      'Pesquise na web as versões atuais do Vite e do Vitest e liste as mudanças que quebram o nosso build',
    );
    expect(['claude', 'agy', 'kimi', 'grok']).toContain(route.adapterId);
    expect(route.reason).toContain('exige busca na web');
  });

  it('em Hardened, helper somente leitura só vai para CLI que confina leitura', async () => {
    // O pty-ipc recusa "cannot enforce native read-only authority" fora do
    // Autopilot: a rota não pode entregar uma CLI que o spawn vai derrubar.
    h.listProviderSettings.mockReturnValue([
      { adapterId: 'mimo-code', enabled: true, installed: true, authStrategy: 'oauth', models: ['xiaomi/mimo-v2.6-flash'] },
      { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth', models: ['kimi-code/k3'] },
      { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-6-luna'] },
    ]);
    const free = await routeLikeSpawn(MEDIUM_TASK);
    expect(['mimo-code', 'kimi']).toContain(free.adapterId);
    const confined = await routeLikeSpawn(MEDIUM_TASK, { requireReadOnlyEnforceable: true });
    expect(confined.adapterId).toBe('codex');
    expect(confined.reason).toContain('somente leitura');
  });
});

describe('"+ Pane": especialidade da tarefa escolhe a CLI', () => {
  beforeEach(() => {
    h.listProviderSettings.mockReturnValue([
      { adapterId: 'claude', enabled: true, installed: true, authStrategy: 'oauth', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'] },
      { adapterId: 'codex', enabled: true, installed: true, authStrategy: 'oauth', models: ['gpt-6-luna'] },
      { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth', models: ['kimi-code/k3'] },
      { adapterId: 'agy', enabled: true, installed: true, authStrategy: 'oauth', models: ['gemini-3.8-flash-medium', 'gemini-3.8-flash-low'] },
    ]);
  });

  it('interface vai para a lane de topo e documentação para a rota barata: CLIs diferentes', async () => {
    const VISUAL_TASK = 'Ajustar o layout responsivo e o espaçamento do cabeçalho da tela de login';
    const visual = await routeLikeSpawn(VISUAL_TASK);
    const doc = await routeLikeSpawn('Atualizar o README com o guia de instalação');
    expect(visual.reason).toContain('specialty=visual');
    expect(visual.reason).toContain('lane visual');
    expect(doc.reason).toContain('specialty=doc');
    expect(doc.reason).not.toContain('lane visual');
    // F-1313: o Kimi ("ótimo em front, lento") está na lane visual e ela
    // espalha por uso — o pai já ocupa o Claude, então o Kimi leva a tela.
    expect(visual).toMatchObject({ adapterId: 'kimi', model: 'kimi-code/k3' });
    expect(doc.adapterId).not.toBe(visual.adapterId);
    // Com o Kimi ocupado, a próxima tela volta ao topo da lane (Opus 5.5).
    h.livePanes = [...h.livePanes, { ...livePane('pane-helper-kimi', 'kimi'), sessionId: 's-helper-kimi' }];
    const next = await routeLikeSpawn(VISUAL_TASK);
    expect(next.reason).toContain('lane visual');
    expect(next).toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-5' });
  });

  it('a tabela de especialidade MEDIDA também é consultada fora de missão', async () => {
    h.benchmark = {
      schemaVersion: 1,
      source: 'nexus-benchmark/v1',
      specialties: {
        visual: [{ adapterId: 'codex', model: 'gpt-6-luna', score: 94 }],
        bug: [{ adapterId: 'kimi', model: 'kimi-code/k3', score: 91 }],
      },
    };
    const visual = await routeLikeSpawn('criar a nova tela de onboarding com estados vazios e acessibilidade');
    const bug = await routeLikeSpawn('corrigir o bug do crash ao salvar o contato com campos vazios');
    expect(visual.reason).toContain('specialty=visual source=benchmark');
    expect(bug.reason).toContain('specialty=bug source=benchmark');
  });
});
