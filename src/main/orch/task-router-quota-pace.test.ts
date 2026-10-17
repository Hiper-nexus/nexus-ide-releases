import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import { DEFAULT_ROUTING_TABLE, routeTask, type AdapterAvailability, type RouteContext } from './task-router';
import type { QuotaPace } from './quota-pace';
import { scoreRouteCandidate } from './route-pipeline';

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

describe('baldes de cota no escritor econômico', () => {
  const fleet: AdapterAvailability[] = [
    { id: 'glm', installed: true, models: ['glm-5.3'] },
    { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
  ];
  const route = (quotaPace?: Map<string, QuotaPace>) =>
    routeTask(WRITE, fleet, DEFAULT_ROUTING_TABLE, 'medium', false, BUILTIN_MODEL_CATALOG,
      { multiScore: false, ...(quotaPace ? { quotaPace } : {}) })!;

  it('+0,5 de ritmo não passa por cima da ordem (mesmo balde: ordem atual)', () => {
    const base = route();
    expect(route(new Map([['glm', pace(1.06)], ['kimi', pace(1.3)]])).adapterId).toBe(base.adapterId);
  });

  it('CLI escassa (< 0,67) perde para a que está sem leitura', () => {
    const base = route();
    const scarce = route(new Map([[base.adapterId, pace(0.5)]]));
    expect(scarce.adapterId).not.toBe(base.adapterId);
  });
});

describe('custo de assinatura no multi-score', () => {
  const easy = 'Implemente a validação do campo de e-mail no cadastro com teste';
  const fleet: AdapterAvailability[] = [
    { id: 'glm-flash', installed: true, models: ['glm-5.3-flash[1m]'] },
    { id: 'grok', installed: true, models: ['grok-4.7'] },
  ];
  const route = (quotaPace?: Map<string, QuotaPace>) =>
    routeTask(easy, fleet, DEFAULT_ROUTING_TABLE, 'easy', false, BUILTIN_MODEL_CATALOG,
      { multiScore: true, ...(quotaPace ? { quotaPace } : {}) })!;
  const grokEntry = { c: { adapterId: 'grok', model: 'grok-4.7' }, fromTier: 'easy' as const };
  const cost = (ratio?: number) =>
    scoreRouteCandidate(grokEntry, 0, {
      tier: 'easy',
      modelCatalog: BUILTIN_MODEL_CATALOG,
      context: ratio === undefined ? {} : { quotaPace: new Map([['grok', pace(ratio)]]) },
    }).cost;

  it('com ritmo >= 1 o custo marginal é cota (teto 1), com menos ou sem leitura é o do catálogo', () => {
    expect(cost()).toBe(-16);
    expect(cost(0.9)).toBe(-16);
    expect(cost(1)).toBe(-4);
    expect(cost(2.5)).toBe(-4);
  });

  it('grok com ritmo 2,5 vence o easy que perdia por custo; sem leitura segue perdendo', () => {
    expect(route().adapterId).toBe('glm-flash');
    expect(route(new Map([['grok', pace(2.5)]])).adapterId).toBe('grok');
  });
});
