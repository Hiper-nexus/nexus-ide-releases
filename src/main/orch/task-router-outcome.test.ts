import { describe, expect, it } from 'vitest';
import type { ModelCatalog } from '../adapters/model-catalog';
import { buildRouteSuccessIndex } from './route-pipeline';
import {
  routeTask,
  type AdapterAvailability,
  type RouteContext,
  type RoutingTable,
} from './task-router';

// F-773 (G4): a rota aprende com o desfecho real (taxa de sucesso 14d por CLI
// e modelo), mas pedido explícito e diversidade da missão continuam mandando.
const adapters: AdapterAvailability[] = [
  { id: 'grok', installed: true, models: ['grok-4.7'] },
  { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
  { id: 'glm', installed: true, models: ['glm-5.3'] },
];

const table: RoutingTable = {
  trivial: [],
  easy: [],
  medium: [
    { adapterId: 'grok', model: 'grok-4.7' },
    { adapterId: 'kimi', model: 'kimi-code/k3' },
    { adapterId: 'glm', model: 'glm-5.3' },
  ],
  hard: [],
  critical: [],
};

// Catálogo vazio: qualidade e custo neutros para todos — só posição e sucesso.
const flat = { adapters: {} } as ModelCatalog;

const grokFailing = buildRouteSuccessIndex([
  { adapterId: 'grok', model: 'grok-4.7', successes: 2, total: 10 },
  { adapterId: 'kimi', model: 'kimi-code/k3', successes: 9, total: 10 },
]);

const route = (task: string, context: RouteContext) =>
  routeTask(task, adapters, table, 'medium', false, flat, { multiScore: true, ...context });

describe('routeTask com o laço de resultado (F-773)', () => {
  it('a CLI que mais falhou em 14 dias perde a liderança e o recibo mostra por quê', () => {
    expect(route('ajuste o parser de datas', {})!.adapterId).toBe('grok');

    const decision = route('ajuste o parser de datas', { routeOutcomes: grokFailing });
    expect(decision!.adapterId).toBe('kimi');
    expect(decision!.reason).toContain('sucesso 14d: kimi:kimi-code/k3 0,90 (10), grok:grok-4.7 0,20 (10)');
  });

  it('pedido explícito do operador continua vencendo, mesmo com taxa ruim', () => {
    const decision = route('ajuste o parser de datas com o grok-4.7', { routeOutcomes: grokFailing });
    expect(decision!.adapterId).toBe('grok');
    expect(decision!.reason).toContain('modelo pedido no texto: grok:grok-4.7');
  });

  it('a diversidade da missão continua: quem já tem assento cede, mesmo com 90%', () => {
    const decision = route('ajuste o parser de datas', {
      routeOutcomes: grokFailing,
      missionUsedAdapters: new Set(['kimi']),
      missionUseCounts: new Map([['kimi', 1]]),
    });
    expect(decision!.adapterId).not.toBe('kimi');
  });

  it('sem amostra mínima a ordem é a de sempre', () => {
    const decision = route('ajuste o parser de datas', {
      routeOutcomes: buildRouteSuccessIndex([
        { adapterId: 'grok', model: 'grok-4.7', successes: 0, total: 4 },
      ]),
    });
    expect(decision!.adapterId).toBe('grok');
    expect(decision!.reason).not.toContain('sucesso 14d');
  });
});
