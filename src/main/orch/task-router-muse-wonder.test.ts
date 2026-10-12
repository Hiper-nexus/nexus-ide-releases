import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import { DEFAULT_ROUTING_TABLE, routeTask, type AdapterAvailability } from './task-router';

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

const route = (pool: AdapterAvailability[], tier: 'trivial' | 'medium' | 'hard' | 'critical') =>
  routeTask('ajustar o módulo', pool, DEFAULT_ROUTING_TABLE, tier, false, BUILTIN_MODEL_CATALOG, {});

describe('rota do Muse com o catálogo 1.4.6 (F-1391)', () => {
  it.each(['hard', 'critical'] as const)('%s → muse-wonder-full-1.0', (tier) => {
    const decision = route([MUSE_146], tier);
    expect(decision?.adapterId).toBe('muse');
    expect(decision?.model).toBe('muse-wonder-full-1.0');
  });

  it('crítico pede xhigh, nunca max (o wonder não tem max)', () => {
    expect(route([MUSE_146], 'critical')?.effort).toBe('xhigh');
  });

  it.each(['trivial', 'medium'] as const)('%s → muse-wonder-1.0 (o default novo)', (tier) => {
    expect(route([MUSE_146], tier)?.model).toBe('muse-wonder-1.0');
  });

  it('CLI sem o wonder segue no spark-1.3 (sem promoção de linha para o wonder)', () => {
    expect(route([MUSE_13], 'critical')?.model).toBe('muse-spark-1.3');
    expect(route([MUSE_13], 'medium')?.model).toBe('muse-spark-1.3');
  });
});
