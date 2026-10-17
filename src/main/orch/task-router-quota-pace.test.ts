import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import { DEFAULT_ROUTING_TABLE, routeTask, type AdapterAvailability, type RouteContext } from './task-router';
import type { QuotaPace } from './quota-pace';

const WRITE = 'Implemente o filtro de status na listagem de pedidos com testes';
const pace = (ratio: number): QuotaPace => ({ ratio, window: 'Semanal' });

describe('ritmo de cota no roteamento', () => {
  const fleet: AdapterAvailability[] = [
    { id: 'glm', installed: true, models: ['glm-5.3'] },
    { id: 'grok', installed: true, models: ['grok-4.7'] },
    { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
  ];
  const route = (context: RouteContext = {}) =>
    routeTask(WRITE, fleet, DEFAULT_ROUTING_TABLE, 'medium', false, BUILTIN_MODEL_CATALOG, context)!;

  for (const multiScore of [false, true]) {
    describe(`multiScore=${multiScore}`, () => {
      it('sem quotaPace a decisão é a de antes', () => {
        const before = route({ multiScore });
        expect(route({ multiScore, quotaPace: new Map() })).toMatchObject({
          adapterId: before.adapterId,
          model: before.model,
        });
      });

      it('assinatura com sobra que expira (grok 2,5×) vence o writer medium', () => {
        const before = route({ multiScore });
        expect(before.adapterId).not.toBe('grok');
        const decision = route({
          multiScore,
          quotaPace: new Map([['grok', pace(2.5)], ['glm', pace(0.5)], ['kimi', pace(0)]]),
        });
        expect(decision.adapterId).toBe('grok');
      });
    });
  }

  it('o recibo do multi-score cita o termo de cota do líder', () => {
    const decision = route({ multiScore: true, quotaPace: new Map([['grok', pace(2.5)]]) });
    expect(decision.reason).toMatch(/cota: grok ritmo 2,5× \(\+8\)/);
  });
});

describe('writer hard espalha entre econômicos por uso 7d', () => {
  it('com frontier high-risk o fair-share entre econômicos vale', () => {
    const models = new Map<string, Set<string>>();
    for (const entry of DEFAULT_ROUTING_TABLE.hard) {
      models.set(entry.adapterId, (models.get(entry.adapterId) ?? new Set()).add(entry.model!));
    }
    const adapters: AdapterAvailability[] = [...models].map(([id, list]) => ({ id, installed: true, models: [...list] }));
    const globalUseCounts = new Map<string, number>();
    const picks = new Set<string>();
    for (let index = 0; index < 20; index++) {
      const decision = routeTask(
        'Corrija o bug de corrida no reconectar do pane e adicione testes',
        adapters, undefined, 'hard', false, BUILTIN_MODEL_CATALOG, { multiScore: true, globalUseCounts },
      )!;
      picks.add(decision.adapterId);
      globalUseCounts.set(decision.adapterId, (globalUseCounts.get(decision.adapterId) ?? 0) + 1);
    }
    expect(picks.size).toBeGreaterThan(2);
  });
});
