import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import type { SpecialtyBenchmark } from '../../shared/mission-route-specialty';
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

  describe.each([false, true])('multiScore=%s', (multiScore) => {
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
  const score = (ratio?: number, measuredPolicy?: boolean) =>
    scoreRouteCandidate(grokEntry, 0, {
      tier: 'easy',
      modelCatalog: BUILTIN_MODEL_CATALOG,
      context: ratio === undefined ? {} : { quotaPace: new Map([['grok', pace(ratio)]]) },
      ...(measuredPolicy ? { measuredPolicy } : {}),
    });
  const cost = (ratio?: number) => score(ratio).cost;

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

  it('política medida: nem o teto de custo de assinatura nem o termo de cota se aplicam (N3)', () => {
    expect(score(2.5, true).cost).toBe(-16);
    expect(score(2.5, true).quota).toBe(0);
    expect(score(2.5, true).total).toBe(score(undefined, true).total);
    expect(score(2.5).quota).toBeGreaterThan(0);
  });
});

describe('rotas protegidas não cedem ao ritmo de cota (N3)', () => {
  const fleet: AdapterAvailability[] = [
    { id: 'glm', installed: true, models: ['glm-5.3'] },
    { id: 'grok', installed: true, models: ['grok-4.7'] },
    { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
  ];
  const spareGrok = new Map([['grok', pace(2.5)], ['glm', pace(0.5)], ['kimi', pace(0)]]);
  const same = (after: { adapterId: string; model?: string }, before: { adapterId: string; model?: string }) =>
    expect(after).toMatchObject({ adapterId: before.adapterId, model: before.model });

  it('benchmark medido: a ordem medida vale, o ritmo não muda a rota nem aparece no recibo', () => {
    const route = (extra: RouteContext = {}) =>
      routeTask(WRITE, fleet, DEFAULT_ROUTING_TABLE, 'medium', false, BUILTIN_MODEL_CATALOG, { multiScore: true, ...extra })!;
    const specialty = route().specialty!;
    const specialtyBenchmark: SpecialtyBenchmark = {
      schemaVersion: 1,
      source: 'nexus-benchmark/2026-10-03',
      specialties: {
        [specialty]: [
          { adapterId: 'glm', model: 'glm-5.3', score: 92 },
          { adapterId: 'kimi', model: 'kimi-code/k3', score: 88 },
        ],
      },
    };
    const before = route({ specialtyBenchmark });
    expect(before.policySource).toBe('benchmark');
    expect(before.adapterId).not.toBe('grok');
    const after = route({ specialtyBenchmark, quotaPace: spareGrok });
    same(after, before);
    expect(after.reason).not.toContain('cota:');
    // Controle: a heurística (sem benchmark) cede ao mesmo ritmo.
    expect(route({ quotaPace: spareGrok }).adapterId).toBe('grok');
  });

  it('critical + security: o topo não cede à cota de uma assinatura mais barata', () => {
    const claudeFleet: AdapterAvailability[] = [
      { id: 'claude', installed: true, models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
      { id: 'codex', installed: true, models: ['gpt-6.1-sol'] },
      ...fleet,
    ];
    const task = 'Corrija a vulnerabilidade de injeção de SQL na autenticação do pagamento em produção';
    const route = (quotaPace?: Map<string, QuotaPace>) =>
      routeTask(task, claudeFleet, DEFAULT_ROUTING_TABLE, 'critical', false, BUILTIN_MODEL_CATALOG,
        { multiScore: true, ...(quotaPace ? { quotaPace } : {}) })!;
    const before = route();
    expect(before.specialty).toBe('security');
    same(
      route(new Map([['claude', pace(0.3)], ['codex', pace(0.3)], ['kimi', pace(2.5)], ['grok', pace(2.5)], ['glm', pace(2.5)]])),
      before,
    );
  });

  it('menção explícita de modelo no texto vence o ritmo de cota', () => {
    const route = (quotaPace?: Map<string, QuotaPace>) =>
      routeTask(`${WRITE} com o glm-5.3`, fleet, DEFAULT_ROUTING_TABLE, 'medium', false, BUILTIN_MODEL_CATALOG,
        { multiScore: true, ...(quotaPace ? { quotaPace } : {}) })!;
    const before = route();
    expect(before.reason).toContain('modelo pedido no texto: glm:glm-5.3');
    same(route(spareGrok), before);
    expect(before.adapterId).toBe('glm');
  });
});
