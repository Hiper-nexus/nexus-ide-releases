import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import { DEFAULT_ROUTING_TABLE, JUDGE_FRONTIER_LANE, VISUAL_FRONTIER_LANE, routeTask, type AdapterAvailability } from './task-router';

// F-1391: o Muse 1.4.6 traz o catálogo Meta com muse-wonder-1.0 (default) e
// muse-wonder-full-1.0 (o mais forte). Tarefa difícil/crítica no Muse vai
// para o wonder-full; CLI que ainda não lista o wonder cai no spark-1.3.
const MUSE_146: AdapterAvailability = {
  id: 'muse',
  installed: true,
  models: ['muse-wonder-full-1.0', 'muse-wonder-1.0', 'muse-spark-1.3', 'muse-spark-1.2'],
};
const MUSE_13: AdapterAvailability = {
  id: 'muse',
  installed: true,
  models: ['muse-spark-1.3', 'muse-spark-1.2'],
};

const route = (pool: AdapterAvailability[], tier: 'trivial' | 'easy' | 'medium' | 'hard' | 'critical') =>
  routeTask('ajustar o módulo', pool, DEFAULT_ROUTING_TABLE, tier, false, BUILTIN_MODEL_CATALOG, {});

describe('rota do Muse com o catálogo 1.4.6 (F-1391)', () => {
  it.each(['hard', 'critical'] as const)('%s → muse-wonder-full-1.0', (tier) => {
    const decision = route([MUSE_146], tier);
    expect(decision?.adapterId).toBe('muse');
    expect(decision?.model).toBe('muse-wonder-full-1.0');
  });

  it('F-1398: crítico mantém xhigh da política de tier fora das lanes', () => {
    expect(route([MUSE_146], 'critical')?.effort).toBe('xhigh');
  });

  it.each(['trivial', 'easy', 'medium'] as const)('%s → muse-wonder-1.0 (o default novo)', (tier) => {
    expect(route([MUSE_146], tier)?.model).toBe('muse-wonder-1.0');
  });

  it('CLI sem o wonder segue no spark-1.3 (sem promoção de linha para o wonder)', () => {
    expect(route([MUSE_13], 'critical')?.model).toBe('muse-spark-1.3');
    expect(route([MUSE_13], 'medium')?.model).toBe('muse-spark-1.3');
  });
});


describe('F-1398: Muse Full nas lanes e contributor com consentimento', () => {
  const contributor = (consent?: boolean): AdapterAvailability => ({
    ...MUSE_146,
    models: [...(MUSE_146.models ?? []), 'muse-wonder-1.0-contributor', 'muse-wonder-full-1.0-contributor'],
    museContributorConsent: consent,
  });

  it('visual sem Opus escolhe Full com max antes do Codex', () => {
    const decision = routeTask('criar a nova tela de onboarding com estados vazios e acessibilidade', [
      contributor(true), { id: 'codex', installed: true, models: ['gpt-6.1-sol'] },
    ], DEFAULT_ROUTING_TABLE, 'medium', false, BUILTIN_MODEL_CATALOG, { multiScore: false });
    expect(decision).toMatchObject({ adapterId: 'muse', model: 'muse-wonder-full-1.0', effort: 'max' });
    expect(decision?.reason).toContain('lane visual');
    // F-1623: Muse Full é reserva (grupo 3), depois do Sonnet e do DeepSeek, com max.
    const full = VISUAL_FRONTIER_LANE.find((seat) => seat.model === 'muse-wonder-full-1.0');
    expect(full).toMatchObject({ adapterId: 'muse', effort: 'max', group: 3 });
    expect(full?.preferenceOnly).not.toBe(true);
  });

  it('Full julga com high no hard quando Claude e Codex não estão disponíveis', () => {
    const decision = routeTask('Revise o diff do worker e dê o veredito', [contributor(true)],
      DEFAULT_ROUTING_TABLE, 'hard', false, BUILTIN_MODEL_CATALOG, { multiScore: false });
    expect(decision).toMatchObject({ adapterId: 'muse', model: 'muse-wonder-full-1.0', effort: 'high' });
    expect(decision?.reason).toContain('lane de julgamento');
    expect(decision?.judgeUnavailable).toBeUndefined();
    expect(JUDGE_FRONTIER_LANE).toContainEqual({ adapterId: 'muse', model: 'muse-wonder-full-1.0', effort: 'max' });
  });

  it.each(['trivial', 'easy', 'medium'] as const)('%s com consentimento usa contributor e informa o uso do conteúdo', (tier) => {
    const decision = route([contributor(true)], tier);
    expect(decision?.model).toBe('muse-wonder-1.0-contributor');
    expect(decision?.reason).toContain('contributor (conteúdo pode ser usado pela Meta)');
  });

  it('easy sem consentimento recusa contributor mesmo anunciado pela CLI', () => {
    expect(route([contributor(false)], 'easy')?.model).toBe('muse-wonder-1.0');
  });

  it.each(['hard', 'critical'] as const)('%s com consentimento continua usando Full comum', (tier) => {
    expect(route([contributor(true)], tier)?.model).toBe('muse-wonder-full-1.0');
  });
});


describe('F-1398 ADD3: Wonder Full lidera o julgamento', () => {
  const judges: AdapterAvailability[] = [MUSE_146,
    { id: 'claude', installed: true, models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'] },
    { id: 'codex', installed: true, models: ['gpt-6.1-sol', 'gpt-6-astra'] },
  ];
  const judge = (pool: AdapterAvailability[]) => routeTask('Revise o diff do worker e dê o veredito', pool,
    DEFAULT_ROUTING_TABLE, 'hard', false, BUILTIN_MODEL_CATALOG, { multiScore: true });
  it('primeiro assento elegível é Wonder Full, antes de Fable e Astra; hard fica em high', () => {
    expect(JUDGE_FRONTIER_LANE[0]).toMatchObject({ adapterId: 'muse', model: 'muse-wonder-full-1.0', effort: 'max' });
    expect(judge(judges)).toMatchObject({ adapterId: 'muse', model: 'muse-wonder-full-1.0', effort: 'high' });
  });
  it('critical aplica o max do assento; hard não', () => {
    const pool = judges;
    const review = 'Revise o diff do worker e dê o veredito';
    expect(routeTask(review, pool, DEFAULT_ROUTING_TABLE, 'critical', false, BUILTIN_MODEL_CATALOG, { multiScore: true }))
      .toMatchObject({ adapterId: 'muse', model: 'muse-wonder-full-1.0', effort: 'max' });
    expect(routeTask(review, pool, DEFAULT_ROUTING_TABLE, 'hard', false, BUILTIN_MODEL_CATALOG, { multiScore: true }))
      .toMatchObject({ adapterId: 'muse', model: 'muse-wonder-full-1.0', effort: 'high' });
  });
  it('sem Muse pronto preserva o Fable como fallback', () => {
    expect(judge(judges.filter((a) => a.id !== 'muse'))).toMatchObject({ adapterId: 'claude', model: 'claude-fable-5-1' });
  });
});
