import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import {
  buildRouteSuccessIndex,
  routeProvenFailure,
  routeSuccessRate,
  scoreRouteCandidate,
} from './route-pipeline';
import {
  DEFAULT_ROUTING_TABLE,
  routeTask,
  type AdapterAvailability,
  type RouteContext,
} from './task-router';

// Revisão do e5f647d418: rotação por missão, fair-share e boost de preferência
// escolhem o MENOS usado — e a rota comprovadamente falha (muse 0/7) é
// exatamente a menos usada. Ela sai desses pools enquanto houver outra pronta;
// só sobrando ela, o comportamento antigo (fail-open) continua.
// Só o modelo falho: sem irmão, a única rota muse do pool é a comprovada falha.
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
const WRITER_PROMPT = 'Implemente a atualização automática das CLIs no macOS preservando os panes vivos';

const museFailing = buildRouteSuccessIndex([
  { adapterId: 'muse', model: 'muse-wonder-full-1.0', successes: 0, total: 7 },
]);

const run = (pool: AdapterAvailability[], extra: Partial<RouteContext>, prompt = WRITER_PROMPT) =>
  routeTask(prompt, pool, DEFAULT_ROUTING_TABLE, 'hard', false, BUILTIN_MODEL_CATALOG, {
    multiScore: false,
    ...extra,
  })!;

describe('pools de menor uso não promovem rota comprovadamente falha', () => {
  it('fair-share global {claude:30, muse:0}: muse 0/7 não lidera', () => {
    const decision = run([MUSE, CLAUDE], {
      routeOutcomes: museFailing,
      globalUseCounts: new Map([['claude', 30], ['muse', 0]]),
    });
    expect(decision.adapterId).not.toBe('muse');
    expect(decision.reason).not.toContain('fair-share: muse');
  });

  it('rotação garantida com missionUsedAdapters {claude}: muse 0/7 não entra', () => {
    const decision = run([MUSE, CLAUDE], {
      routeOutcomes: museFailing,
      missionUsedAdapters: new Set(['claude']),
    });
    expect(decision.adapterId).not.toBe('muse');
    expect(decision.reason).not.toContain('rotação garantida: muse');
  });

  it('fail-open: só o muse instalado segue sendo o destino com fair-share ativo', () => {
    const decision = run([MUSE], {
      routeOutcomes: museFailing,
      globalUseCounts: new Map([['muse', 0]]),
      missionUsedAdapters: new Set(['claude']),
    });
    expect(decision.adapterId).toBe('muse');
  });

  it('sem a falha provada (0/4) o fair-share continua mandando para o menos usado', () => {
    const decision = run([MUSE, CLAUDE], {
      routeOutcomes: buildRouteSuccessIndex([
        { adapterId: 'muse', model: 'muse-wonder-full-1.0', successes: 0, total: 4 },
      ]),
      globalUseCounts: new Map([['claude', 30], ['muse', 0]]),
    });
    expect(decision.adapterId).toBe('muse');
  });

  it('preferAdapters: preferir muse 0/7 não o devolve ao topo', () => {
    const decision = run([MUSE, CLAUDE], {
      routeOutcomes: museFailing,
      preferAdapters: ['muse'],
    });
    expect(decision.adapterId).not.toBe('muse');
  });
});

describe('demoção dura exige amostra do próprio modelo', () => {
  const index = buildRouteSuccessIndex([
    { adapterId: 'muse', model: 'muse-wonder-full-1.0', successes: 0, total: 7 },
  ]);

  it('modelo irmão sem amostra própria herda a taxa da CLI mas não a demoção dura', () => {
    expect(routeSuccessRate(index, 'muse', 'muse-spark-1.3')).toMatchObject({ scope: 'cli', rate: 0 });
    expect(routeProvenFailure(index, 'muse', 'muse-spark-1.3')).toBeNull();
    expect(routeProvenFailure(index, 'muse', 'muse-wonder-full-1.0')).toMatchObject({ scope: 'model' });
  });

  it('o irmão não é excluído de escritor econômico nem da lane pela falha da CLI', () => {
    const decision = routeTask(
      'Revise o diff do worker e dê o veredito',
      [MUSE, CLAUDE],
      DEFAULT_ROUTING_TABLE,
      'hard',
      false,
      BUILTIN_MODEL_CATALOG,
      { multiScore: false, routeOutcomes: buildRouteSuccessIndex([
        { adapterId: 'muse', model: 'muse-wonder-full-1.0', successes: 0, total: 7 },
      ]) },
    )!;
    expect(decision.reason).not.toMatch(/evitou rota falha: muse:muse-spark/);
  });

  it('multi-score: −30 só no modelo com amostra própria; o irmão paga só o termo contínuo', () => {
    const score = (model: string) =>
      scoreRouteCandidate({ c: { adapterId: 'muse', model }, fromTier: 'hard' }, 0, {
        tier: 'hard',
        modelCatalog: BUILTIN_MODEL_CATALOG,
        context: { routeOutcomes: index },
      }).success;
    expect(score('muse-wonder-full-1.0')).toBe(-5 - 30);
    expect(score('muse-spark-1.3')).toBe(-5);
  });
});
