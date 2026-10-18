import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_CATALOG } from '../adapters/model-catalog';
import type { SpecialtyBenchmark } from '../../shared/mission-route-specialty';
import { adapterCircuitBreakers } from './circuit-breaker';
import { buildRouteSuccessIndex } from './route-pipeline';
import {
  DEFAULT_ROUTING_TABLE,
  routeTask,
  type AdapterAvailability,
  type RouteContext,
  type TaskTier,
} from './task-router';

// Limites do bloco "líder falho cede" do multi-score (188a9815d9) que a revisão
// final deixou sem teste (review-verdict-1e4aff66): a reserva do Claude, o
// critical, a política medida e o circuito aberto. Rota falha = amostra do
// próprio modelo (>= 5) com taxa <= 0,2; o bloco só roda com multi-score ligado
// (histórico da missão, circuito aberto ou multiScore: true).
const MUSE_FULL = 'muse-wonder-full-1.0';
const MUSE: AdapterAvailability = { id: 'muse', installed: true, models: [MUSE_FULL] };
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
const GROK: AdapterAvailability = { id: 'grok', installed: true, models: ['grok-4.7'] };
const WRITER =
  'Implemente a atualização automática das CLIs no macOS preservando os panes vivos';
const SECURITY_AUDIT = 'auditar a segurança da autenticação';

/** 0 sucessos em 7 tentativas por rota: falha provada com amostra do próprio modelo. */
const failing = (...routes: ReadonlyArray<readonly [adapterId: string, model: string]>) =>
  buildRouteSuccessIndex(
    routes.map(([adapterId, model]) => ({ adapterId, model, successes: 0, total: 7 })),
  );

/** 2 assentos em claude e em codex (−36 cada): com isso o muse 0/7 lidera o rerank. */
const SEATED = new Map([['claude', 2], ['codex', 2]]);

const route = (
  task: string,
  pool: AdapterAvailability[],
  context: RouteContext,
  tier?: TaskTier,
  reserveClaude = false,
) =>
  routeTask(task, pool, DEFAULT_ROUTING_TABLE, tier, reserveClaude, BUILTIN_MODEL_CATALOG, context)!;

const pick = (decision: { adapterId: string; model?: string }) =>
  `${decision.adapterId}:${decision.model}`;

afterEach(() => adapterCircuitBreakers.reset());

describe('reserveClaude: a reserva não devolve a rota falha', () => {
  // O bloco do líder falho põe o Claude pronto no topo e estaciona o muse 0/7
  // em alternatives[0] — de onde a reserva o puxava de volta.
  const ctx: RouteContext = {
    multiScore: true,
    missionUseCounts: SEATED,
    routeOutcomes: failing(['muse', MUSE_FULL]),
  };

  it('troca o Claude pela 1ª alternativa pronta (Sol), não pela falha estacionada', () => {
    const decision = route(WRITER, [MUSE, CLAUDE, CODEX], ctx, 'hard', true);
    expect(pick(decision)).toBe('codex:gpt-6.1-sol');
    expect(decision.reason).toContain('evitou rota falha: muse:muse-wonder-full-1.0 0,00 (7)');
  });

  it('fail-open: só a rota falha fora do Claude ⇒ a reserva ainda a usa', () => {
    const decision = route(WRITER, [MUSE, CLAUDE], ctx, 'hard', true);
    expect(pick(decision)).toBe(`muse:${MUSE_FULL}`);
  });
});

describe('critical: o líder frontier falho cede ao próximo frontier pronto', () => {
  const critical = (pool: AdapterAvailability[], routeOutcomes?: RouteContext['routeOutcomes']) =>
    route(WRITER, pool, { multiScore: true, ...(routeOutcomes ? { routeOutcomes } : {}) }, 'critical');

  it('opus 0/7 → fable, o 2º do topo high-risk', () => {
    // Controle: sem a falha o opus lidera, então a troca vem da evidência.
    expect(pick(critical([CLAUDE, CODEX]))).toBe('claude:claude-opus-5-5');
    const decision = critical([CLAUDE, CODEX], failing(['claude', 'claude-opus-5-5']));
    expect(pick(decision)).toBe('claude:claude-fable-5-1');
    expect(decision.reason).toContain('topo=high-risk');
    expect(decision.reason).toContain('evitou rota falha: claude:claude-opus-5-5 0,00 (7)');
  });

  it('opus 0/7 e a CLI sem o fable → o Sol do Codex', () => {
    const decision = critical(
      [{ ...CLAUDE, models: ['claude-opus-5-5'] }, CODEX],
      failing(['claude', 'claude-opus-5-5']),
    );
    expect(pick(decision)).toBe('codex:gpt-6.1-sol');
  });
});

describe('auditoria de segurança crítica com assento falho (F-817/F-1477)', () => {
  // Grok e Muse prontos e com assento na lane geral: se a troca do líder falho
  // vazasse, um deles assumiria a auditoria.
  const audit = (routeOutcomes: RouteContext['routeOutcomes']) =>
    route(SECURITY_AUDIT, [CLAUDE, CODEX, GROK, MUSE], {
      multiScore: true,
      missionUseCounts: SEATED,
      routeOutcomes,
    });

  it('fable 0/7 (1º da lane) cede ao opus; Grok e Muse não herdam a auditoria', () => {
    const decision = audit(failing(['claude', 'claude-fable-5-1']));
    expect(decision.tier).toBe('critical');
    expect(decision.specialty).toBe('security');
    expect(pick(decision)).toBe('claude:claude-opus-5-5');
    expect(decision.reason).toContain('lane de julgamento (segurança crítica: Claude/Codex)');
    expect(decision.reason).toContain('evitou rota falha: claude:claude-fable-5-1 0,00 (7)');
  });

  it('fail-open: todo assento Claude/Codex falha ⇒ segue Claude/Codex, nunca Grok/Muse', () => {
    const decision = audit(
      failing(
        ['claude', 'claude-fable-5-1'],
        ['claude', 'claude-opus-5-5'],
        ['claude', 'claude-sonnet-5-5'],
        ['codex', 'gpt-6.1-sol'],
      ),
    );
    expect(['claude', 'codex']).toContain(decision.adapterId);
    expect(decision.reason).toContain('lane de julgamento (segurança crítica: Claude/Codex)');
    expect(decision.judgeUnavailable).toBeUndefined();
  });
});

describe('política medida (benchmark): comportamento atual com a líder medida falha', () => {
  // Benchmark de "feature" (a especialidade do WRITER) com o muse no topo: a
  // ordem medida o põe à frente e o rerank o mantém líder (sonda muse 0/7).
  const benchmark: SpecialtyBenchmark = {
    schemaVersion: 1,
    source: 'nexus-benchmark/2026-10-03',
    specialties: {
      feature: [
        { adapterId: 'muse', model: MUSE_FULL, score: 95 },
        { adapterId: 'claude', model: 'claude-opus-5-5', score: 90 },
        { adapterId: 'codex', model: 'gpt-6.1-sol', score: 85 },
      ],
    },
  };
  const measured = (context: RouteContext) =>
    route(
      WRITER,
      [MUSE, CLAUDE, CODEX],
      { specialtyBenchmark: benchmark, routeOutcomes: failing(['muse', MUSE_FULL]), ...context },
      'hard',
    );

  it('com multi-score a líder medida falha cede à 1ª pronta do tier e a política segue benchmark', () => {
    const decision = measured({ multiScore: true, missionUseCounts: SEATED });
    expect(decision.policySource).toBe('benchmark');
    expect(pick(decision)).toBe('claude:claude-opus-5-5');
    expect(decision.reason).toContain('evitou rota falha: muse:muse-wonder-full-1.0 0,00 (7)');
  });

  it('limite atual (documenta, não endossa): sem multi-score a ordem medida vale e a falha lidera', () => {
    // 1ª rota da missão: sem histórico nem circuito aberto o bloco do líder não roda.
    const decision = measured({});
    expect(decision.policySource).toBe('benchmark');
    expect(pick(decision)).toBe(`muse:${MUSE_FULL}`);
    expect(decision.reason).not.toContain('evitou rota falha');
  });
});

describe('circuito aberto na única alternativa pronta: fail-open mantém a falha', () => {
  const trip = (...ids: string[]) => {
    for (const id of ids) for (let i = 0; i < 3; i += 1) adapterCircuitBreakers.recordFailure(id);
  };

  it('claude (o único pronto) com circuito aberto: a falha segue e o recibo não finge evitá-la', () => {
    trip('claude');
    const decision = route(WRITER, [MUSE, CLAUDE], {
      multiScore: true,
      routeOutcomes: failing(['muse', MUSE_FULL]),
    }, 'hard');
    expect(pick(decision)).toBe(`muse:${MUSE_FULL}`);
    expect(decision.reason).not.toContain('evitou rota falha');
    expect(decision.alternatives.some((c) => c.adapterId === 'claude')).toBe(false);
  });

  it('todos abertos: o bloco do líder não promove rota em circuito aberto sobre a falha', () => {
    // Com algum circuito fechado o rerank já descarta os abertos (caso acima);
    // só com todos abertos eles chegam ao bloco, onde a guarda os recusa.
    trip('muse', 'claude');
    const decision = route(WRITER, [MUSE, CLAUDE], {
      multiScore: true,
      missionUseCounts: new Map([['claude', 2]]),
      routeOutcomes: failing(['muse', MUSE_FULL]),
    }, 'hard');
    expect(pick(decision)).toBe(`muse:${MUSE_FULL}`);
    expect(decision.reason).not.toContain('evitou rota falha');
  });
});
