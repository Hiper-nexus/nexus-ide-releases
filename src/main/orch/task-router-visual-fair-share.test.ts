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

  it('cinco tarefas visuais distribuem cinco modelos, incluindo os dois Claude', () => {
    const visualUseCounts = new Map<string, number>();
    const picks: string[] = [];
    for (let index = 0; index < 5; index++) {
      const decision = route('implementar a tela responsiva de cadastro com estados vazios', everyone, { visualUseCounts });
      const key = `${decision.adapterId}:${decision.model}`;
      picks.push(key);
      visualUseCounts.set(key, (visualUseCounts.get(key) ?? 0) + 1);
    }
    expect(picks).toEqual([
      'claude:claude-opus-5-5', 'claude:claude-sonnet-5-5', 'muse:muse-wonder-full-1.0',
      'kimi:kimi-code/k3', 'codex:gpt-6.1-sol',
    ]);
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

  it('uso recente por modelo distingue Opus ocupado de Sonnet livre na mesma CLI', () => {
    const decision = route('implementar a tela responsiva de cadastro', everyone, {
      visualUseCounts: new Map([['claude:claude-opus-5-5', 10]]),
    });
    expect(decision).toMatchObject({ adapterId: 'claude', model: 'claude-sonnet-5-5' });
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
  it('Next/jogo mantém max mesmo se o Jev pedir effort menor', () => {
    expect(route('criar landing em Next.js', [
      { id: 'claude', installed: true, models: ['claude-opus-5-5'] }, ...pool,
    ], { effortOverride: 'low' })).toMatchObject({ model: 'claude-opus-5-5', effort: 'max' });
  });
});


it('F-1398/F-1400: esforço do assento visual vence esforço genérico do Jev', () => {
  expect(visual({ effortOverride: 'low' })).toMatchObject({ adapterId: 'muse', effort: 'max' });
});
