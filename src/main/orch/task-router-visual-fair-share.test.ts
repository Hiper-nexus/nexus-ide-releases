import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import { DEFAULT_ROUTING_TABLE, routeTask, type AdapterAvailability, type RouteContext } from './task-router';

const pool: AdapterAvailability[] = [
  { id: 'muse', installed: true, models: ['muse-wonder-full-1.0', 'muse-wonder-1.0', 'muse-spark-1.3'] },
  { id: 'codex', installed: true, models: ['gpt-6.1-sol', 'gpt-6-luna'] },
  { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
];
const route = (task: string, adapters: AdapterAvailability[], context: RouteContext = {}) => routeTask(
  task, adapters, DEFAULT_ROUTING_TABLE, 'medium', false, BUILTIN_MODEL_CATALOG,
  { multiScore: true, ...context },
)!;
const visual = (context: RouteContext) => route('implementar a tela responsiva e seus componentes visuais', pool, context);

describe('F-1400: lane visual reparte uso recente sem Claude', () => {
  it('três tarefas consecutivas dão assento a Muse Full, Codex e Kimi usando apenas uso global recente', () => {
    const globalUseCounts = new Map<string, number>();
    const picks: string[] = [];
    for (let index = 0; index < 3; index++) {
      const decision = visual({ globalUseCounts });
      picks.push(decision.adapterId);
      globalUseCounts.set(decision.adapterId, (globalUseCounts.get(decision.adapterId) ?? 0) + 1);
      if (decision.adapterId === 'muse') {
        expect(decision.model).toBe('muse-wonder-full-1.0');
        expect(decision.effort).toBe('max');
      }
      expect(decision.specialty).toBe('visual');
    }
    expect([...picks].sort()).toEqual(['codex', 'kimi', 'muse']);
  });

  it('Kimi com menos uso global vence com missão empatada e preferência explícita', () => {
    const decision = visual({
      missionUseCounts: new Map([['kimi', 0], ['codex', 0], ['muse', 0]]),
      globalUseCounts: new Map([['kimi', 0], ['codex', 10], ['muse', 10]]),
      preferAdapters: ['kimi'],
    });
    expect(decision.adapterId).toBe('kimi');
    expect(decision.model).toBe('kimi-code/k3');
  });

  it('Kimi com menos uso global vence pelo espalhamento mesmo sem preferência explícita', () => {
    expect(visual({ globalUseCounts: new Map([['kimi', 0], ['codex', 10], ['muse', 10]]) }).adapterId).toBe('kimi');
  });

  it('preferência Kimi com uso global igual é atendida dentro da lane', () => {
    expect(visual({ globalUseCounts: new Map(), preferAdapters: ['kimi'] }).adapterId).toBe('kimi');
  });

  it('preferência não monopoliza: Kimi com mais uso global cede a outro assento', () => {
    const decision = visual({ globalUseCounts: new Map([['kimi', 10], ['codex', 0], ['muse', 0]]), preferAdapters: ['kimi'] });
    expect(['muse', 'codex']).toContain(decision.adapterId);
  });

  it('uso da missão tem precedência sobre uso global contraditório', () => {
    const decision = visual({
      missionUseCounts: new Map([['kimi', 2], ['muse', 1], ['codex', 0]]),
      globalUseCounts: new Map([['kimi', 0], ['muse', 0], ['codex', 100]]), preferAdapters: ['kimi'],
    });
    expect(decision.adapterId).toBe('codex');
    expect(decision.model).toBe('gpt-6.1-sol');
  });
});

describe('F-1400 ADD2: revezamento por modelo e exceção Next/jogo', () => {
  const everyone: AdapterAvailability[] = [
    { id: 'claude', installed: true, models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }, ...pool,
  ];
  // F-1623: o topo de UI completo (Opus 5.5, Gemini Argon, GPT Astra).
  const topPool: AdapterAvailability[] = [
    { id: 'claude', installed: true, models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
    { id: 'agy', installed: true, models: ['gemini-4-argon'], liveModels: ['gemini-4-argon'] },
    { id: 'codex', installed: true, models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'] },
    ...pool.filter((adapter) => adapter.id !== 'codex'),
  ];

  it('F-1623: sem Argon nem Astra, o Opus segura a UI; Sonnet e o resto ficam de reserva', () => {
    const visualUseCounts = new Map<string, number>();
    const picks: string[] = [];
    for (let index = 0; index < 5; index++) {
      const decision = route('implementar a tela responsiva de cadastro com estados vazios', everyone, { visualUseCounts });
      const key = `${decision.adapterId}:${decision.model}`;
      picks.push(key);
      visualUseCounts.set(key, (visualUseCounts.get(key) ?? 0) + 1);
    }
    expect(new Set(picks)).toEqual(new Set(['claude:claude-opus-5-5']));
  });

  it.each(['criar landing em Next.js', 'implementar jogo em canvas', 'criar app router para a tela de cadastro',
    'criar game em Phaser', 'criar jogo em three.js', 'criar game unity webgl',
  ])('regra do operador escolhe Opus max apesar do uso alto: %s', (task) => {
    const decision = route(task, everyone, {
      visualUseCounts: new Map([['claude:claude-opus-5-5', 100]]), preferAdapters: ['kimi'],
    });
    expect(decision).toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-5', effort: 'max' });
    expect(decision.reason).toContain('Next/jogo → Opus 5.5 (regra do operador)');
  });

  it.each(['criar landing em Next.js', 'implementar jogo em canvas'])('sem Claude usa o pool elegível: %s', (task) => {
    expect(route(task, pool)).toMatchObject({ adapterId: 'muse', model: 'muse-wonder-full-1.0', effort: 'max' });
  });

  // F-1400 B1 (revisão Fable): next/game/jogo soltos casavam e a especialidade
  // virava 'visual' sem condição — Opus max forçado e securityWork=false (F-821).
  it.each([
    'fix the next auth session validation', 'prepare the next release of the CLI',
    'game theory for the pricing engine', 'write the migration for the next sprint',
  ])('B1: palavra solta next/game não vira visual nem Opus max: %s', (task) => {
    const decision = route(task, everyone);
    expect(decision.specialty).not.toBe('visual');
    expect(decision.reason).not.toContain('Next/jogo');
    expect(decision.effort).not.toBe('max');
  });

  it.each(['criar um jogo da velha', 'implementar um jogo no Godot', 'fazer um roguelike', 'criar um jogo de plataforma'])(
    'Grok: jogo é sempre Opus max, sem exigir palavra de contexto: %s', (task) => {
      const decision = route(task, everyone, { visualUseCounts: new Map([['claude:claude-opus-5-5', 100]]) });
      expect(decision).toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-5', effort: 'max' });
      expect(decision.reason).toContain('Next/jogo → Opus 5.5 (regra do operador)');
    });

  // Revisão Fable R1: frases medidas na revisão cruzada.
  it.each(['Implement the next step of the pagination handler', 'Write the game plan for the migration',
    'Create the game plan for the migration'])('Fable R1: next/game soltos não viram visual Opus max: %s', (task) => {
    const decision = route(task, everyone);
    expect(decision.reason).not.toContain('Next/jogo');
    expect(decision.specialty).not.toBe('visual');
  });

  it('Fable R1: security em Next.js app router nunca é sobrescrita', () => {
    const decision = route('Fix auth bug in the Next.js app router', everyone);
    expect(decision.specialty).toBe('security');
    expect(decision.reason).not.toContain('Next/jogo');
  });

  it('Fable R1: "Next steps" do brief anexado (classificationText) não aciona Next/jogo', () => {
    const decision = route('Implementar o filtro de status da listagem de pedidos', topPool, {
      classificationText: 'Implementar o filtro de status da listagem de pedidos\n\n## Next steps\n- criar um jogo de exemplo com create-next-app',
      visualUseCounts: new Map([['claude:claude-opus-5-5', 100]]),
    });
    expect(decision.reason).not.toContain('Next/jogo');
    expect(decision.model).not.toBe('claude-opus-5-5');
  });

  it.each(['prepare the next app release', 'ship the next app version'])('Grok: "next app" em inglês genérico não é Next.js: %s', (task) => {
    const decision = route(task, everyone);
    expect(decision.reason).not.toContain('Next/jogo');
    expect(decision.effort).not.toBe('max');
  });

  it.each(['criar landing em Next JS', 'criar landing em next-js', 'criar landing com create-next-app'])(
    'Grok: variantes de Next.js mantêm Opus max: %s', (task) => {
      const decision = route(task, everyone, { visualUseCounts: new Map([['claude:claude-opus-5-5', 100]]) });
      expect(decision).toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-5', effort: 'max' });
      expect(decision.reason).toContain('Next/jogo → Opus 5.5 (regra do operador)');
    });

  it.each([
    'explain game theory examples in the browser docs', 'explicar a teoria dos jogos no navegador',
    'the name of the game is the 2d array', 'fix the pricing game on the strategy canvas',
    'criar exemplos de teoria dos jogos',
  ])('Grok: teoria dos jogos e expressão idiomática não pinam Opus: %s', (task) => {
    const decision = route(task, topPool, { visualUseCounts: new Map([['claude:claude-opus-5-5', 100]]) });
    expect(decision.reason).not.toContain('Next/jogo');
    expect(decision.model).not.toBe('claude-opus-5-5');
  });

  it.each(['landing em Next.js', 'fazer um jogo em canvas'])('B1: Next.js e jogo com contexto continuam Opus max: %s', (task) => {
    const decision = route(task, everyone, { visualUseCounts: new Map([['claude:claude-opus-5-5', 100]]) });
    expect(decision).toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-5', effort: 'max', specialty: 'visual' });
    expect(decision.reason).toContain('Next/jogo → Opus 5.5 (regra do operador)');
  });

  it.each(['corrigir XSS no app Next.js', 'corrigir XSS na landing em Next.js'])(
    'Grok: defeito de segurança vence visual e Next/jogo em qualquer work-kind: %s', (task) => {
      const decision = routeTask(task, everyone, DEFAULT_ROUTING_TABLE, undefined, false, BUILTIN_MODEL_CATALOG, { multiScore: true })!;
      expect(decision).toMatchObject({ tier: 'critical', specialty: 'security' });
      expect(decision.reason).not.toContain('Next/jogo');
      expect(decision.adapterId).not.toBe('muse');
    });

  it('B1: segurança em app Next.js continua security (F-821), sem Opus max da regra de front', () => {
    const decision = route('corrigir XSS no app Next.js', everyone);
    expect(decision.specialty).toBe('security');
    expect(decision.reason).not.toContain('Next/jogo');
    expect(decision.effort).not.toBe('max');
  });

  it('F-1623: Devin é reserva — com o topo pronto não recebe UI; sem topo, Sonnet e DeepSeek, reveza no fim', () => {
    const withDevin: AdapterAvailability[] = [...topPool, { id: 'devin', installed: true, models: ['swe-2-high', 'swe-2-medium'] }];
    const visualUseCounts = new Map<string, number>();
    for (let index = 0; index < 6; index++) {
      const decision = route('implementar a tela responsiva de cadastro com estados vazios', withDevin, { visualUseCounts });
      const key = `${decision.adapterId}:${decision.model}`;
      expect(decision.adapterId).not.toBe('devin');
      visualUseCounts.set(key, (visualUseCounts.get(key) ?? 0) + 1);
    }
    const reserveOnly: AdapterAvailability[] = [
      { id: 'devin', installed: true, models: ['swe-2-high', 'swe-2-medium'] },
      { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
    ];
    const picks = new Set<string>();
    const reserveUse = new Map<string, number>();
    for (let index = 0; index < 2; index++) {
      const decision = route('implementar a tela responsiva de cadastro com estados vazios', reserveOnly, { visualUseCounts: reserveUse });
      const key = `${decision.adapterId}:${decision.model}`;
      picks.add(key);
      reserveUse.set(key, (reserveUse.get(key) ?? 0) + 1);
    }
    expect(picks).toEqual(new Set(['devin:swe-2-high', 'kimi:kimi-code/k3']));
  });

  it('Kimi com K3.1 Pro e K3 ocupa um assento só no rodízio: o K3 é reserva de CLI antiga', () => {
    const reserveOnly: AdapterAvailability[] = [
      { id: 'devin', installed: true, models: ['swe-2-high', 'swe-2-medium'] },
      { id: 'kimi', installed: true, models: ['kimi-code/k3.1-pro', 'kimi-code/k3'] },
    ];
    const picks = new Set<string>();
    const reserveUse = new Map<string, number>();
    for (let index = 0; index < 4; index++) {
      const decision = route('implementar a tela responsiva de cadastro com estados vazios', reserveOnly, { visualUseCounts: reserveUse });
      const key = `${decision.adapterId}:${decision.model}`;
      picks.add(key);
      reserveUse.set(key, (reserveUse.get(key) ?? 0) + 1);
    }
    expect(picks).toEqual(new Set(['devin:swe-2-high', 'kimi:kimi-code/k3.1-pro']));
  });

  it('F-1623: Opus ocupado passa a vez a outro do topo, não ao Sonnet (reserva)', () => {
    const decision = route('implementar a tela responsiva de cadastro', topPool, {
      visualUseCounts: new Map([['claude:claude-opus-5-5', 10]]),
    });
    expect(['agy:gemini-4-argon', 'codex:gpt-6-astra']).toContain(`${decision.adapterId}:${decision.model}`);
  });

  it('F-1623: DeepSeek Flash é a reserva logo depois do Sonnet', () => {
    const noTop: AdapterAvailability[] = [
      ...pool,
      { id: 'deepseek', installed: true, models: ['deepseek-v4-pro', 'deepseek-flash'] },
    ];
    const decision = route('implementar a tela responsiva de cadastro com estados vazios', noTop, {
      visualUseCounts: new Map([['deepseek:deepseek-flash', 10]]),
    });
    expect(decision).toMatchObject({ adapterId: 'deepseek', model: 'deepseek-flash' });
    expect(decision.reason).toContain('lane visual');
  });

  it('DeepSeek Flash é escolhido para tarefa frontend com preferAdapters deepseek', () => {
    const withDeepSeek: AdapterAvailability[] = [
      ...everyone,
      { id: 'deepseek', installed: true, models: ['deepseek-v4-pro', 'deepseek-flash'] },
    ];
    const decision = route('criar componente front-end em React com CSS', withDeepSeek, {
      preferAdapters: ['deepseek'],
    });
    expect(decision).toMatchObject({
      adapterId: 'deepseek',
      model: 'deepseek-flash',
      specialty: 'visual',
    });
  });

  it('DeepSeek Flash no Claude e no Qwen também são elegíveis na visual frontier lane', () => {
    const poolClaudeFlash: AdapterAvailability[] = [
      { id: 'claude', installed: true, models: ['deepseek-flash'] },
      ...pool,
    ];
    const decisionClaude = route('implementar UI do dashboard em React', poolClaudeFlash, {
      preferAdapters: ['claude'],
    });
    expect(decisionClaude).toMatchObject({
      adapterId: 'claude',
      model: 'deepseek-flash',
      specialty: 'visual',
    });

    const poolQwenFlash: AdapterAvailability[] = [
      { id: 'qwen', installed: true, models: ['deepseek-flash'] },
      ...pool,
    ];
    const decisionQwen = route('implementar layout responsivo e estilização', poolQwenFlash, {
      preferAdapters: ['qwen'],
    });
    expect(decisionQwen).toMatchObject({
      adapterId: 'qwen',
      model: 'deepseek-flash',
      specialty: 'visual',
    });
  });

  it('specialtyOverride: frontend normaliza para visual e explora DeepSeek Flash', () => {
    const withDeepSeek: AdapterAvailability[] = [
      { id: 'deepseek', installed: true, models: ['deepseek-flash'] },
      ...pool,
    ];
    const decision = route('ajustar fluxo da aplicação', withDeepSeek, {
      specialtyOverride: 'frontend',
      preferAdapters: ['deepseek'],
    });
    expect(decision).toMatchObject({
      adapterId: 'deepseek',
      model: 'deepseek-flash',
      specialty: 'visual',
    });
  });
});


describe('F-1400: transporte de uso visual do ledger', () => {
  it('contagem visual por modelo não herda uso geral do adapter', () => {
    const decision = visual({ globalUseCounts: new Map([
      ['visual:', 0], ['muse', 200], ['visual:muse:muse-wonder-full-1.0', 2],
      ['visual:kimi:kimi-code/k3', 1], ['visual:codex:gpt-6.1-sol', 0],
    ]) });
    expect(decision.adapterId).toBe('codex');
  });
  it('C4: esforço explícito do operador no texto vence o max da regra Next/jogo', () => {
    const decision = route('criar landing em Next.js com esforço low', [
      { id: 'claude', installed: true, models: ['claude-opus-5-5'] }, ...pool,
    ]);
    expect(decision).toMatchObject({ adapterId: 'claude', model: 'claude-opus-5-5', effort: 'low' });
    expect(decision.reason).toContain('requested=low source=texto');
  });
  it('Next/jogo mantém max mesmo se o Jev pedir effort menor', () => {
    expect(route('criar landing em Next.js', [
      { id: 'claude', installed: true, models: ['claude-opus-5-5'] }, ...pool,
    ], { effortOverride: 'low' })).toMatchObject({ model: 'claude-opus-5-5', effort: 'max' });
  });
});


it('F-1398/F-1400: esforço do assento visual vence esforço genérico do Jev', () => {
  expect(visual({ effortOverride: 'low' })).toMatchObject({ adapterId: 'muse', effort: 'max' });
});
