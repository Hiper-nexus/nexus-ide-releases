import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import { buildRouteSuccessIndex } from './route-pipeline';
import {
  DEFAULT_ROUTING_TABLE,
  routeTask,
  type AdapterAvailability,
  type RouteContext,
} from './task-router';

// 17/10: muse-wonder-full-1.0 com 0/7 em 14d liderava writer hard ("escritor
// econômico") e a lane de julgamento — cada spawn morria em credencial
// recusada e a missão caía em failover. Rota comprovadamente falha (amostra
// mínima, taxa <= 0,2) não é promovida por lane nem vira escritor econômico,
// e toma −30 no multi-score. Nunca excluída quando é a única opção e a
// menção explícita do operador continua vencendo.
// Só o modelo com amostra própria: a demoção dura não vale para um irmão que
// apenas herda a taxa da CLI (task-router-failing-pools.test.ts).
const MUSE: AdapterAvailability = {
  id: 'muse',
  installed: true,
  models: ['muse-wonder-full-1.0'],
};
const CLAUDE: AdapterAvailability = {
  id: 'claude',
  installed: true,
  models: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'],
};
const CODEX: AdapterAvailability = {
  id: 'codex',
  installed: true,
  models: ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra'],
};
const PROBE_POOL = [MUSE, CLAUDE, CODEX];
const WRITER =
  'Implemente a atualização automática das CLIs no macOS preservando os panes vivos';

/** Sonda real: multi-score ligado e 2 assentos de claude e de codex (−36). */
const probeCtx = (total: number): RouteContext => ({
  multiScore: true,
  missionUseCounts: new Map([['claude', 2], ['codex', 2]]),
  routeOutcomes: museFailing(total),
});

const museFailing = (total: number) =>
  buildRouteSuccessIndex([
    { adapterId: 'muse', model: 'muse-wonder-full-1.0', successes: 0, total },
  ]);

const ctx = (routeOutcomes?: RouteContext['routeOutcomes']): RouteContext => ({
  multiScore: false,
  ...(routeOutcomes ? { routeOutcomes } : {}),
});

describe('rota comprovadamente falha (muse 0/7, campo 17/10)', () => {
  it('writer hard: o escritor econômico falho não lidera e o recibo diz por quê', () => {
    const decision = routeTask(
      'Implemente a atualização automática das CLIs no macOS preservando os panes vivos',
      [MUSE, CLAUDE],
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      BUILTIN_MODEL_CATALOG,
      ctx(museFailing(7)),
    )!;
    expect(decision.adapterId).not.toBe('muse');
    expect(decision.reason).toContain('evitou rota falha: muse:muse-wonder-full-1.0 0,00 (7)');
  });

  it('lane de julgamento: com claude pronto o assento falho não é promovido', () => {
    const decision = routeTask(
      'Revise o diff do worker e dê o veredito',
      [MUSE, CLAUDE],
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      BUILTIN_MODEL_CATALOG,
      ctx(museFailing(7)),
    )!;
    expect(decision.adapterId).toBe('claude');
    expect(decision.reason).toContain('lane de julgamento');
    expect(decision.reason).toContain('evitou rota falha: muse:muse-wonder-full-1.0 0,00 (7)');
  });

  it('fail-open: só o muse instalado ⇒ a rota falha segue sendo o destino', () => {
    const writer = routeTask(
      'Implemente a atualização automática das CLIs no macOS preservando os panes vivos',
      [MUSE],
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      BUILTIN_MODEL_CATALOG,
      ctx(museFailing(7)),
    )!;
    expect(writer.adapterId).toBe('muse');
    expect(writer.reason).not.toContain('evitou rota falha');

    const judge = routeTask(
      'Revise o diff do worker e dê o veredito',
      [MUSE],
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      BUILTIN_MODEL_CATALOG,
      ctx(museFailing(7)),
    )!;
    expect(judge.adapterId).toBe('muse');
    expect(judge.model).toBe('muse-wonder-full-1.0');
  });

  it('menção explícita do operador vence a falha provada', () => {
    const decision = routeTask(
      'Revise o diff do worker com o muse-wonder-full-1.0',
      [MUSE, CLAUDE],
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      BUILTIN_MODEL_CATALOG,
      ctx(museFailing(7)),
    )!;
    expect(decision.adapterId).toBe('muse');
    expect(decision.reason).toContain('modelo pedido no texto');
  });

  it('abaixo da amostra mínima (0/4) nada muda', () => {
    const writer = routeTask(
      'Implemente a atualização automática das CLIs no macOS preservando os panes vivos',
      [MUSE, CLAUDE],
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      BUILTIN_MODEL_CATALOG,
      ctx(museFailing(4)),
    )!;
    expect(writer.adapterId).toBe('muse');
    expect(writer.model).toBe('muse-wonder-full-1.0');
    expect(writer.reason).not.toContain('evitou rota falha');

    const judge = routeTask(
      'Revise o diff do worker e dê o veredito',
      [MUSE, CLAUDE],
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      BUILTIN_MODEL_CATALOG,
      ctx(museFailing(4)),
    )!;
    expect(judge.adapterId).toBe('muse');
  });

  it('multi-score: a penalidade forte derruba a líder falha mesmo sem lane', () => {
    const pool: AdapterAvailability[] = [
      { id: 'grok', installed: true, models: ['grok-4.7'] },
      { id: 'kimi', installed: true, models: ['kimi-code/k3'] },
    ];
    const table = {
      trivial: [],
      easy: [],
      medium: [
        { adapterId: 'grok', model: 'grok-4.7' },
        { adapterId: 'kimi', model: 'kimi-code/k3' },
      ],
      hard: [],
      critical: [],
    };
    const decision = routeTask('ajuste o parser de datas', pool, table, 'medium', false,
      { adapters: {} } as never, {
        multiScore: true,
        routeOutcomes: buildRouteSuccessIndex([
          { adapterId: 'grok', model: 'grok-4.7', successes: 0, total: 7 },
          { adapterId: 'kimi', model: 'kimi-code/k3', successes: 5, total: 7 },
        ]),
      })!;
    expect(decision.adapterId).toBe('kimi');
    expect(decision.reason).toContain('evitou rota falha: grok:grok-4.7 0,00 (7)');
  });
});

describe('multi-score: o líder pode ser a rota falha (sonda muse 0/7)', () => {
  it('hard com 2 assentos em claude e codex: muse 0/7 não lidera e o recibo diz', () => {
    const decision = routeTask(
      WRITER,
      PROBE_POOL,
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      BUILTIN_MODEL_CATALOG,
      probeCtx(7),
    )!;
    expect(decision.adapterId).not.toBe('muse');
    expect(decision.reason).toContain('evitou rota falha: muse:muse-wonder-full-1.0 0,00 (7)');
  });

  it('fail-open: só o muse instalado segue no muse', () => {
    const decision = routeTask(
      WRITER,
      [MUSE],
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      BUILTIN_MODEL_CATALOG,
      probeCtx(7),
    )!;
    expect(decision.adapterId).toBe('muse');
    expect(decision.model).toBe('muse-wonder-full-1.0');
    expect(decision.reason).not.toContain('evitou rota falha');
  });

  it('menção explícita ao muse continua vencendo', () => {
    const decision = routeTask(
      `${WRITER} com o muse-wonder-full-1.0`,
      PROBE_POOL,
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      BUILTIN_MODEL_CATALOG,
      probeCtx(7),
    )!;
    expect(decision.adapterId).toBe('muse');
    expect(decision.model).toBe('muse-wonder-full-1.0');
    expect(decision.reason).toContain('modelo pedido no texto');
    expect(decision.reason).not.toContain('evitou rota falha');
  });

  it('abaixo da amostra mínima (0/4) o hard não muda', () => {
    const decision = routeTask(
      WRITER,
      PROBE_POOL,
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      BUILTIN_MODEL_CATALOG,
      probeCtx(4),
    )!;
    expect(decision.adapterId).toBe('muse');
    expect(decision.model).toBe('muse-wonder-full-1.0');
    expect(decision.reason).not.toContain('evitou rota falha');
  });

  it('tier medium com a mesma sonda fica no sonnet, como antes', () => {
    const decision = routeTask(
      WRITER,
      PROBE_POOL,
      DEFAULT_ROUTING_TABLE,
      'medium',
      false,
      BUILTIN_MODEL_CATALOG,
      probeCtx(7),
    )!;
    expect(decision.adapterId).toBe('claude');
    expect(decision.model).toBe('claude-sonnet-5-5');
    // O líder já não é a falha: o multi-score anuncia a nota uma vez.
    expect(decision.reason.match(/evitou rota falha/g)).toEqual([
      'evitou rota falha',
    ]);
    expect(decision.reason).toContain('evitou rota falha: muse:muse-wonder-full-1.0 0,00 (7)');
    expect(decision.reason).toContain('escritor econômico elegível no mesmo tier');
  });
});
