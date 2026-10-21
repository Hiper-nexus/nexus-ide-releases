/**
 * Conformidade das regras de modelo do operador — uma tabela de casos por
 * regra (frase da tarefa → expectativa) contra routeTask/classifyTask e as
 * funções afins de task-router.ts e mission-route-specialty.ts.
 *
 * Estas regras estão EM CORREÇÃO por outros writers: o teste registra a
 * expectativa CORRETA, mesmo onde a rota atual ainda falha. Não usar .skip
 * nem .fails — a falha vermelha É o sinal de regressão pendente.
 *
 * Pools e harness copiados de task-router-visual-fair-share.test.ts,
 * route-tools-claude-capacity.test.ts e task-router-cost-policy.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

// --- Harness Main (regra 8) — mesmo padrão de route-tools-claude-capacity.test.ts ---
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
  warmGrokAccountCredentialCache: () => {},
  sessionExpiredBeyondRenewal: () => false,
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

import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import {
  DEFAULT_ROUTING_TABLE,
  classifyTask,
  isFrontierReviewer,
  routeTask,
  type AdapterAvailability,
  type RouteContext,
} from './task-router';
import { classifyRouteSpecialty } from '../../shared/mission-route-specialty';
import { routingPurpose } from './routing-cost-policy';
import { routeTaskForCaller } from './tools-domain';

/** Rota pura sem tier fixo: a classificação da frase é parte da conformidade. */
const route = (task: string, adapters: AdapterAvailability[], context: RouteContext = {}) =>
  routeTask(task, adapters, DEFAULT_ROUTING_TABLE, undefined, false, BUILTIN_MODEL_CATALOG,
    { multiScore: true, ...context })!;

/** Pool de front-end da regra do operador: Opus/Sonnet, Wonder Full, Kimi, Codex e Devin. */
const FRONT_POOL: AdapterAvailability[] = [
  { id: 'claude', installed: true, models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
  { id: 'muse', installed: true, models: ['muse-wonder-full-1.0', 'muse-wonder-1.0', 'muse-spark-1.3'] },
  { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
  { id: 'codex', installed: true, models: ['gpt-6.1-sol', 'gpt-6-luna'] },
  { id: 'devin', installed: true, models: ['swe-2-medium', 'swe-2-high'] },
];

/** F-1623: o topo de UI do operador (Opus 5.5, Gemini Argon, GPT Astra) mais a reserva. */
const TOP_FRONT_POOL: AdapterAvailability[] = [
  { id: 'claude', installed: true, models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
  { id: 'agy', installed: true, models: ['gemini-4-argon'], liveModels: ['gemini-4-argon'] },
  { id: 'codex', installed: true, models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'] },
  { id: 'muse', installed: true, models: ['muse-wonder-full-1.0', 'muse-wonder-1.0', 'muse-spark-1.3'] },
  { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
];

const JUDGE_POOL: AdapterAvailability[] = [
  { id: 'muse', installed: true, models: ['muse-wonder-full-1.0', 'muse-wonder-1.0', 'muse-spark-1.3'] },
  { id: 'claude', installed: true, models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'] },
  { id: 'codex', installed: true, models: ['gpt-6.1-sol', 'gpt-6-luna'] },
  { id: 'glm', installed: true, models: ['glm-5.3'] },
  { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
];

const GLM_POOL: AdapterAvailability[] = [
  { id: 'glm', installed: true, models: ['glm-5.3'] },
  { id: 'glm-flash', installed: true, models: ['glm-5.3-flash[1m]', 'glm-5.3-flash'] },
];

const museOnly = (consent: boolean): AdapterAvailability[] => [
  { id: 'muse', installed: true, museContributorConsent: consent,
    models: ['muse-wonder-full-1.0', 'muse-wonder-1.0', 'muse-wonder-1.0-contributor', 'muse-spark-1.3'] },
];

const noContributor = (decision: ReturnType<typeof route>) => {
  const models = [decision.model, ...decision.alternatives.map((alt) => alt.model)];
  expect(models.filter((model) => model?.endsWith('-contributor'))).toEqual([]);
};

// Regra 1 — Next.js e jogos vão SEMPRE para Opus 5.5 com esforço max.
describe('regra 1: Next.js e jogos → Opus 5.5 max, sempre', () => {
  it.each([
    'criar um jogo da velha',
    'implementar um jogo no Godot',
    'fazer um roguelike',
    'criar landing em Next.js',
    'Next JS landing page',
    'landing em next-js',
  ])('Opus max apesar do uso alto e da preferência por outra CLI: %s', (task) => {
    const decision = route(task, FRONT_POOL, {
      visualUseCounts: new Map([['claude:claude-opus-5-5', 100]]),
      preferAdapters: ['kimi'],
    });
    expect(decision).toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-5', effort: 'max' });
    expect(decision.reason).toContain('Next/jogo → Opus 5.5 (regra do operador)');
  });

  it.each([
    'prepare the next app release',
    'explicar a teoria dos jogos no navegador',
    'the name of the game is the 2d array bounds check',
  ])('falso positivo NÃO cai na regra: %s', (task) => {
    const decision = route(task, FRONT_POOL);
    expect(decision).not.toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-5', effort: 'max' });
    expect(decision.reason).not.toContain('Next/jogo → Opus 5.5 (regra do operador)');
  });
});

// Regra 2 — Esforço explícito escrito na tarefa vence o max da regra 1.
describe('regra 2: esforço explícito no texto vence o max', () => {
  it('"esforço low" na tarefa Next derruba o max para low', () => {
    const decision = route('criar landing em Next.js, esforço low', FRONT_POOL);
    expect(decision).toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-5', effort: 'low' });
  });

  it('esforço pedido pelo Jev (effortOverride) NÃO derruba o max', () => {
    expect(route('criar landing em Next.js', FRONT_POOL, { effortOverride: 'low' }))
      .toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-5', effort: 'max' });
  });
});

// Regra 3 — Segurança e credencial são tier critical + specialty security e
// vencem o visual e o Next/jogo.
describe('regra 3: segurança e credencial são critical/security e vencem visual e Next/jogo', () => {
  const SECURITY_CASES = [
    'corrigir XSS no app Next.js',
    'corrigir XSS na landing em Next.js',
    'renovar a credencial do operador',
    'registrar a linhagem de token da conta',
  ];

  it.each(SECURITY_CASES)('classifyTask → critical: %s', (task) => {
    expect(classifyTask(task).tier).toBe('critical');
  });

  it.each(SECURITY_CASES)('classifyRouteSpecialty → security: %s', (task) => {
    expect(classifyRouteSpecialty(task).specialty).toBe('security');
  });

  it.each(SECURITY_CASES)('routeTask → critical/security, nunca lane visual nem Next/jogo: %s', (task) => {
    const decision = route(task, FRONT_POOL);
    expect(decision.tier).toBe('critical');
    expect(decision.specialty).toBe('security');
    expect(decision.reason).not.toContain('lane visual');
    expect(decision.reason).not.toContain('Next/jogo');
  });

  it.each([
    'página de credenciamento de parceiros',
    'implementar linhagem de dados no ETL',
  ])('falso positivo NÃO é segurança: %s', (task) => {
    expect(classifyRouteSpecialty(task).specialty).not.toBe('security');
    expect(classifyTask(task).tier).not.toBe('critical');
    expect(route(task, FRONT_POOL).specialty).not.toBe('security');
  });
});

// Regra 4 (F-1623, operador 21/10) — UI reveza só o topo: Opus 5.5, Gemini
// Argon e GPT Astra. Quem não tem nenhum deles cai na reserva ordenada:
// Sonnet 5.5, depois DeepSeek, depois Muse Full/Kimi/Codex/Devin.
describe('regra 4: front-end reveza o topo; reserva ordenada para quem não o tem', () => {
  const VISUAL_TASK = 'implementar a tela responsiva de cadastro com estados vazios';
  const TOP = new Set(['claude:claude-opus-5-5', 'agy:gemini-4-argon', 'codex:gpt-6-astra']);
  const rotate = (pool: AdapterAvailability[], times: number): string[] => {
    const visualUseCounts = new Map<string, number>();
    const picks: string[] = [];
    for (let index = 0; index < times; index++) {
      const decision = route(VISUAL_TASK, pool, { visualUseCounts });
      const key = `${decision.adapterId}:${decision.model}`;
      picks.push(key);
      visualUseCounts.set(key, (visualUseCounts.get(key) ?? 0) + 1);
    }
    return picks;
  };

  it('seis tarefas visuais revezam só Opus 5.5, Argon e Astra', () => {
    const picks = rotate(TOP_FRONT_POOL, 6);
    expect(picks.every((key) => TOP.has(key))).toBe(true);
    expect(new Set(picks)).toEqual(TOP);
  });

  it('uso visual concentrado no Opus manda a próxima tarefa a outro do topo', () => {
    const decision = route(VISUAL_TASK, TOP_FRONT_POOL, {
      visualUseCounts: new Map([['claude:claude-opus-5-5', 100]]),
    });
    expect(TOP.has(`${decision.adapterId}:${decision.model}`)).toBe(true);
    expect(decision.model).not.toBe('claude-opus-5-5');
  });

  it('sem o topo: Sonnet 5.5 primeiro, mesmo com uso alto; depois DeepSeek; Devin só no fim', () => {
    const noTop: AdapterAvailability[] = [
      { id: 'claude', installed: true, models: ['claude-sonnet-5-5'] },
      { id: 'deepseek', installed: true, models: ['deepseek-v4-pro', 'deepseek-flash'] },
      ...FRONT_POOL.filter((adapter) => adapter.id !== 'claude'),
    ];
    expect(route(VISUAL_TASK, noTop, { visualUseCounts: new Map([['claude:claude-sonnet-5-5', 100]]) }))
      .toMatchObject({ adapterId: 'claude', model: 'claude-sonnet-5-5' });
    const withoutSonnet = noTop.filter((adapter) => adapter.id !== 'claude');
    expect(route(VISUAL_TASK, withoutSonnet)).toMatchObject({ adapterId: 'deepseek', model: 'deepseek-flash' });
    const rest = rotate(withoutSonnet.filter((adapter) => adapter.id !== 'deepseek'), 4);
    expect(new Set(rest)).toEqual(new Set(['muse:muse-wonder-full-1.0', 'kimi:kimi-code/k3', 'codex:gpt-6.1-sol', 'devin:swe-2-high']));
  });
});

// Regra 5 — Muse Wonder Full fica no topo da lane de julgamento quando disponível.
describe('regra 5: Muse Wonder Full no topo da lane de julgamento', () => {
  const REVIEW_TASK = 'Revise de forma independente o diff da correção do kickoff e dê o veredito';

  it('com Muse disponível, revisão hard vai para o Wonder Full em high', () => {
    const decision = route(REVIEW_TASK, JUDGE_POOL);
    expect(decision.tier).toBe('hard');
    expect(decision).toMatchObject({ adapterId: 'muse', model: 'muse-wonder-full-1.0', effort: 'high' });
    expect(isFrontierReviewer(decision.adapterId, decision.model)).toBe(true);
  });

  it('critical na lane de julgamento usa o max do Wonder Full', () => {
    const decision = routeTask(
      REVIEW_TASK,
      JUDGE_POOL,
      DEFAULT_ROUTING_TABLE,
      'critical',
      false,
      BUILTIN_MODEL_CATALOG,
      { multiScore: true },
    );
    expect(decision).toMatchObject({ adapterId: 'muse', model: 'muse-wonder-full-1.0', effort: 'max' });
  });

  it('sem Muse, o topo da lane cai para o próximo frontier (Fable)', () => {
    const decision = route(REVIEW_TASK, JUDGE_POOL.filter((adapter) => adapter.id !== 'muse'));
    expect(decision).toMatchObject({ adapterId: 'claude', model: 'claude-fable-5-1' });
    expect(isFrontierReviewer(decision.adapterId, decision.model)).toBe(true);
  });
});

// Regra 6 — Muse `-contributor` só trivial/easy/medium, só com consentimento;
// nunca hard, critical, front ou julgamento.
describe('regra 6: Muse -contributor só em tarefa leve e só com consentimento', () => {
  it('trivial com consentimento: o contributor é elegível (escolha ou alternativa)', () => {
    const decision = route('listar os arquivos da pasta', museOnly(true));
    expect(decision.adapterId).toBe('muse');
    expect([decision.model, ...decision.alternatives.map((alt) => alt.model)])
      .toContain('muse-wonder-1.0-contributor');
  });

  it('sem consentimento o contributor nunca é escolhido nem alternativa', () => {
    const decision = route('listar os arquivos da pasta', museOnly(false));
    expect(decision.model).toBe('muse-wonder-1.0');
    noContributor(decision);
  });

  it.each([
    'refatorar o parser do protocolo de sincronização de dados',
    'auditar a segurança da autenticação e dos pagamentos',
  ])('hard/critical nunca recebe contributor, mesmo com consentimento: %s', (task) => {
    const decision = route(task, museOnly(true));
    expect(decision.adapterId).toBe('muse');
    expect(decision.model).toBe('muse-wonder-full-1.0');
    noContributor(decision);
  });

  it('front-end nunca recebe contributor, mesmo com consentimento', () => {
    // F-1621: front trivial/easy sai da lane de topo (rota do tier), mas o
    // contributor continua fora de toda tarefa visual.
    const light = route('implementar a tela de login responsiva', museOnly(true));
    expect(light.adapterId).toBe('muse');
    noContributor(light);
    const screen = route('implementar a tela responsiva de cadastro com estados vazios', museOnly(true));
    expect(screen).toMatchObject({ adapterId: 'muse', model: 'muse-wonder-full-1.0' });
    noContributor(screen);
  });

  it('julgamento nunca recebe contributor, mesmo com consentimento', () => {
    const decision = route('Revise o diff do código e dê o veredito', museOnly(true));
    expect(decision).toMatchObject({ adapterId: 'muse', model: 'muse-wonder-full-1.0' });
    noContributor(decision);
  });
});

// Regra 7 — GLM 5.3 Flash para tarefas leves e leitura de imagem; GLM 5.3
// para código medium ou mais difícil.
describe('regra 7: GLM Flash no leve/imagem, GLM 5.3 no código medium+', () => {
  it.each([
    'verificar o status do deploy',
    'ler a imagem anexada e descrever o conteúdo',
  ])('tarefa leve/leitura de imagem → glm-flash: %s', (task) => {
    const decision = route(task, GLM_POOL);
    expect(decision.adapterId).toBe('glm-flash');
    expect(decision.model).toMatch(/^glm-5\.3-flash/);
  });

  it.each([
    'implementar a rotina de cache do módulo',
    'refatorar o parser do protocolo de sincronização de dados',
  ])('código medium ou mais difícil → glm-5.3: %s', (task) => {
    const decision = route(task, GLM_POOL);
    expect(decision).toMatchObject({ adapterId: 'glm', model: 'glm-5.3' });
  });
});

// Regra 8 — Não existe limite de "um pane Claude por conta": N panes na mesma
// conta continuam elegíveis (F-1401, harness de route-tools-claude-capacity).
describe('regra 8: N panes Claude na mesma conta continuam elegíveis', () => {
  const ctx: AgentGateContext = {
    token: 't', label: 'orquestrador da aba', role: 'orchestrator', sessionId: 'orch',
    missionId: 'mission-tab', providerId: 'claude', scope: testProjectScope(),
    allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false,
  };
  const TASK = 'auditar a segurança da autenticação e dos pagamentos';
  const TAB_MISSION = {
    id: 'mission-tab', status: 'running', title: 'Missão · Terminais',
    intentContract: { workspaceBinding: { version: 1, adoptedPaneId: 'pane-orch' } },
  };
  const livePane = (paneId: string, adapterId: string) =>
    ({ paneId, sessionId: `s-${paneId}`, adapterId, state: 'busy', missionId: 'mission-tab' });

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

  const routeViaCaller = () => routeTaskForCaller({ task: TASK, preferAdapters: ['claude'] }, ctx) as Promise<{
    adapterId: string;
    reason: string;
  }>;

  it('Maestro + 3 workers Claude vivos na MESMA conta: claude segue elegível', async () => {
    // Sem o codex, o Claude é o único candidato do tier crítico — elegível
    // significa que ele vence, não que cai numa alternativa (padrão F-1401).
    h.listProviderSettings.mockReturnValue([
      { adapterId: 'claude', enabled: true, installed: true, authStrategy: 'oauth',
        models: ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1'] },
      { adapterId: 'kimi', enabled: true, installed: true, authStrategy: 'oauth',
        models: ['kimi-code/k3'] },
    ]);
    h.recorded = [
      { paneId: 'pane-orch', adapterId: 'claude', role: 'orchestrator' },
      { paneId: 'pane-w1', adapterId: 'claude', role: 'worker' },
      { paneId: 'pane-w2', adapterId: 'claude', role: 'worker' },
      { paneId: 'pane-w3', adapterId: 'claude', role: 'worker' },
    ];
    h.livePanes = [
      livePane('pane-orch', 'claude'), livePane('pane-w1', 'claude'),
      livePane('pane-w2', 'claude'), livePane('pane-w3', 'claude'),
    ];
    const decision = await routeViaCaller();
    expect(decision.adapterId).toBe('claude');
    expect(decision.reason).not.toContain('reservado');
    expect(decision.reason).not.toContain('claude=não instalado');
  });

  it('a barreira real permanece: nenhuma conta Claude utilizável → indisponível com motivo', async () => {
    h.claudeCapacity.mockReturnValue(0);
    const decision = await routeViaCaller();
    expect(decision.adapterId).not.toBe('claude');
    expect(decision.reason).toContain('nenhuma conta Claude utilizável');
  });
});

// Regra 9 — Revisão só leitura usa purpose=reviewer; revisão de segurança
// crítica nunca vai para escritor econômico.
describe('regra 9: revisão só leitura é reviewer; segurança crítica nunca é escritor econômico', () => {
  it('routingPurpose marca a revisão somente leitura como reviewer', () => {
    expect(routingPurpose('Revise o diff da correção, somente leitura', true)).toBe('reviewer');
    const decision = route('Revise o diff da correção, somente leitura', JUDGE_POOL);
    expect(decision.reason).toContain('purpose=reviewer');
  });

  it('auditoria de segurança crítica fica na lane de julgamento Claude/Codex, nunca no GLM econômico', () => {
    const decision = route('auditar a segurança da autenticação e dos pagamentos', JUDGE_POOL);
    expect(decision.tier).toBe('critical');
    expect(decision.specialty).toBe('security');
    expect(['claude', 'codex']).toContain(decision.adapterId);
    expect(decision.adapterId).not.toBe('glm');
    expect(isFrontierReviewer(decision.adapterId, decision.model)).toBe(true);
    expect(decision.reason).toContain('lane de julgamento (segurança crítica: Claude/Codex)');
    expect(decision.reason).not.toContain('escritor econômico');
  });
});
