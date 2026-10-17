/**
 * Candidate-pipeline scoring for task routing — patterns from x-algorithm
 * (Apache-2.0): Source→Filter→Score→Select with candidate isolation and
 * diversity attenuation. Pure TS; no Electron.
 *
 * Does NOT replace DEFAULT_ROUTING_TABLE capability ordering — it re-ranks
 * already-hydrated candidates with multi-axis scores + mission diversity.
 */
import type { ModelCatalog } from '../adapters/model-catalog';
import {
  hasAuthoritativeModelQuality,
  modelCatalogInfo,
  modelRoutingRank,
} from '../adapters/model-catalog';
import { TIER_ORDER } from './task-router';
import type { RankedRouteEntry, RouteContext, TaskTier } from './task-router';
import { publishedCodingQuality } from './published-benchmarks';
import { quotaPaceScore } from './quota-pace';

/**
 * Nota neutra (6..24 → midpoint 15) para modelo sem nexus-eval nem benchmark
 * oficial publicado. Sem número o modelo não é nem premiado nem condenado ao
 * piso — o custo, a diversidade e a saúde do circuito é que diferenciam.
 */
export const NEUTRAL_UNPUBLISHED_QUALITY = 15;

/**
 * F-773 (G4): laço de resultado. A nota da rota aprende com o desfecho real
 * dos handoffs (status do worker + veredito do Maestro no ACK) por (CLI,
 * modelo), numa janela de 14 dias. Abaixo de 5 amostras o termo é zero:
 * amostra pequena não decide nada.
 */
export const ROUTE_OUTCOME_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const ROUTE_OUTCOME_MIN_SAMPLES = 5;
/**
 * Termo = (taxa − 0,5) × 10, no máximo ±5: menos que um degrau de tier (−10)
 * e muito menos que um assento repetido na missão (−18). Desempata e vira
 * disputa apertada; não passa por cima de tier, diversidade nem menção.
 */
export const ROUTE_OUTCOME_WEIGHT = 10;
/**
 * "Comprovadamente falha": com amostra mínima e taxa <= 0,2 a rota já provou
 * que falha (campo 17/10: muse 0/7 liderava writer e lane de julgamento e
 * todo spawn morria em credencial recusada → failover). A penalidade (−30)
 * perde para menção explícita só pela ordem de aplicação (a menção remonta
 * o ranking depois do multi-score); com uma única opção ela segue elegível
 * (fail-open — a penalidade move o placar, nunca exclui).
 */
export const ROUTE_FAILING_MAX_RATE = 0.2;
export const ROUTE_FAILING_PENALTY = -30;

export interface RouteOutcomeCount {
  readonly adapterId: string;
  readonly model?: string;
  readonly successes: number;
  readonly total: number;
}

export interface RouteOutcomeTally {
  successes: number;
  total: number;
}

/** Contagens por (CLI, modelo) e o agregado da CLI. */
export interface RouteSuccessIndex {
  readonly byModel: ReadonlyMap<string, RouteOutcomeTally>;
  readonly byAdapter: ReadonlyMap<string, RouteOutcomeTally>;
  readonly minSamples: number;
}

export interface RouteSuccessRate {
  readonly rate: number;
  readonly samples: number;
  /** De onde veio a taxa: o modelo exato ou, sem amostra dele, a CLI inteira. */
  readonly scope: 'model' | 'cli';
}

const outcomeModelKey = (adapterId: string, model: string | undefined) =>
  `${adapterId}\0${model ?? ''}`;

export function buildRouteSuccessIndex(
  rows: readonly RouteOutcomeCount[],
  minSamples: number = ROUTE_OUTCOME_MIN_SAMPLES,
): RouteSuccessIndex {
  const byModel = new Map<string, RouteOutcomeTally>();
  const byAdapter = new Map<string, RouteOutcomeTally>();
  const add = (map: Map<string, RouteOutcomeTally>, key: string, row: RouteOutcomeCount) => {
    const tally = map.get(key) ?? { successes: 0, total: 0 };
    tally.successes += row.successes;
    tally.total += row.total;
    map.set(key, tally);
  };
  for (const row of rows) {
    if (!row.adapterId || !(row.total > 0) || row.successes < 0 || row.successes > row.total) {
      continue;
    }
    if (row.model) add(byModel, outcomeModelKey(row.adapterId, row.model), row);
    add(byAdapter, row.adapterId, row);
  }
  return { byModel, byAdapter, minSamples };
}

/**
 * Taxa do candidato: a do (CLI, modelo) quando há amostra suficiente; senão a
 * da CLI inteira (o harness da CLI falha para qualquer modelo); senão null —
 * sem termo.
 */
export function routeSuccessRate(
  index: RouteSuccessIndex | undefined,
  adapterId: string,
  model: string | undefined,
): RouteSuccessRate | null {
  if (!index) return null;
  const exact = model ? index.byModel.get(outcomeModelKey(adapterId, model)) : undefined;
  if (exact && exact.total >= index.minSamples) {
    return { rate: exact.successes / exact.total, samples: exact.total, scope: 'model' };
  }
  const cli = index.byAdapter.get(adapterId);
  if (cli && cli.total >= index.minSamples) {
    return { rate: cli.successes / cli.total, samples: cli.total, scope: 'cli' };
  }
  return null;
}

/** "0,82 (17)" — vírgula decimal, como o resto do recibo da rota. */
export function formatRouteSuccessRate(rate: RouteSuccessRate): string {
  return `${rate.rate.toFixed(2).replace('.', ',')} (${rate.samples}${rate.scope === 'cli' ? ', CLI' : ''})`;
}

/**
 * A rota já provou que falha: taxa com a amostra mínima exigida por
 * {@link routeSuccessRate} e <= {@link ROUTE_FAILING_MAX_RATE}. Devolve a
 * taxa medida (para o recibo) ou null — sem amostra, sem veredito.
 * A demoção DURA exige amostra do próprio (CLI, modelo): a taxa herdada da CLI
 * só alimenta o termo contínuo — um modelo irmão sem amostra não paga pela CLI.
 */
export function routeProvenFailure(
  index: RouteSuccessIndex | undefined,
  adapterId: string,
  model: string | undefined,
): RouteSuccessRate | null {
  const rate = routeSuccessRate(index, adapterId, model);
  return rate && rate.scope === 'model' && rate.rate <= ROUTE_FAILING_MAX_RATE ? rate : null;
}

export interface ScoreBreakdown {
  table: number;
  quality: number;
  cost: number;
  diversity: number;
  preference: number;
  /** F-773: (taxa de sucesso 14d − 0,5) × 10; 0 sem amostra mínima. */
  success: number;
  /** Ritmo de cota da CLI (±10; ×0,5 no critical); 0 sem leitura. */
  quota: number;
  circuit: number;
  total: number;
}

export interface ScoredRouteEntry extends RankedRouteEntry {
  score: ScoreBreakdown;
}

export interface MultiScoreInput {
  ranked: RankedRouteEntry[];
  tier: TaskTier;
  context?: RouteContext;
  modelCatalog: ModelCatalog;
  /** adapterId → open (true = do not prefer). */
  circuitOpen?: ReadonlyMap<string, boolean> | ((adapterId: string) => boolean);
  /** How many times each adapter already appears in the mission. */
  missionUseCounts?: ReadonlyMap<string, number>;
  /**
   * Política da rota medida (benchmark de especialidade): a ordem medida manda,
   * então o ritmo de cota não entra no custo nem no termo `quota`.
   */
  measuredPolicy?: boolean;
}

function isCircuitOpen(
  adapterId: string,
  circuitOpen: MultiScoreInput['circuitOpen'],
): boolean {
  if (!circuitOpen) return false;
  if (typeof circuitOpen === 'function') return circuitOpen(adapterId);
  return circuitOpen.get(adapterId) === true;
}

function useCount(
  adapterId: string,
  counts: ReadonlyMap<string, number> | undefined,
  used: ReadonlySet<string> | undefined,
): number {
  if (counts?.has(adapterId)) return counts.get(adapterId) ?? 0;
  if (used?.has(adapterId)) return 1;
  return 0;
}

/**
 * Score one candidate in isolation (x-algorithm candidate isolation).
 * Diversity uses only mission history, not peer candidates in this batch.
 */
export function scoreRouteCandidate(
  entry: RankedRouteEntry,
  index: number,
  input: Omit<MultiScoreInput, 'ranked'>,
): ScoreBreakdown {
  const { c } = entry;
  // Uso geral: a distância de tier domina (−10 por degrau errado); a posição
  // na lista é só desempate (−0.5 por posição). A ordem da tabela não é uma
  // medida de capacidade — quem manda é a nota de qualidade abaixo.
  const table =
    -10 *
      Math.abs(
        TIER_ORDER.indexOf(entry.fromTier) - TIER_ORDER.indexOf(input.tier),
      ) -
    0.5 * index;

  const info = modelCatalogInfo(input.modelCatalog, c.adapterId, c.model);
  const authoritativeQuality = hasAuthoritativeModelQuality(info)
    ? info?.quality
    : undefined;
  const publishedQuality = c.model
    ? publishedCodingQuality(c.adapterId, c.model)
    : null;
  // F-675 + uso geral: nexus-eval > benchmark oficial publicado > neutro.
  // quality = 2 × q com q clampado em 6..24, então a nota vai de 12 a 48 e
  // um benchmark forte vence a ordem da lista em qualquer posição do tier.
  const qualityRaw =
    authoritativeQuality?.coding ??
    authoritativeQuality?.overall ??
    publishedQuality ??
    NEUTRAL_UNPUBLISHED_QUALITY;
  const quality =
    2 * Math.min(24, Math.max(6, Number(qualityRaw) || NEUTRAL_UNPUBLISHED_QUALITY));

  // Política medida: o ritmo de cota não vale (rotação, fair-share e custo do
  // escritor também deixam o benchmark em paz no roteador).
  const pace = input.measuredPolicy ? undefined : input.context?.quotaPace?.get(c.adapterId);
  // Assinatura medida e não escassa (ritmo >= 1): o custo marginal é cota, não
  // o preço de API do catálogo; a escassez já pesa no termo `quota`. Modelo
  // bloqueado (Infinity) continua bloqueado.
  const catalogRank = modelRoutingRank(info);
  const costRank =
    pace && pace.ratio >= 1 && Number.isFinite(catalogRank)
      ? Math.min(catalogRank, 1)
      : catalogRank;
  // Hard pesa o custo quase como medium (×1.5): com 26 dos 71 spawns pinados
  // no mesmo provider caro, o hard barato com nota próxima deve ganhar.
  // Critical continua leve (×0.5) — ali a capacidade manda.
  const cost =
    input.tier === 'trivial' || input.tier === 'easy'
      ? -costRank * 4
      : input.tier === 'medium' || input.tier === 'hard'
        ? -costRank * 1.5
        : -costRank * 0.5;

  const times = useCount(
    c.adapterId,
    input.missionUseCounts,
    input.context?.missionUsedAdapters,
  );
  // Author-diversity attenuation (x-algorithm Author Diversity Scorer).
  const diversity = -times * 18;

  let preference = 0;
  if (input.context?.preferAdapters?.includes(c.adapterId)) {
    preference += 4;
  }

  // F-773 (G4): o que o (CLI, modelo) entregou de verdade nos últimos 14 dias.
  const outcome = routeSuccessRate(input.context?.routeOutcomes, c.adapterId, c.model);
  const success = outcome
    ? (outcome.rate - 0.5) * ROUTE_OUTCOME_WEIGHT +
      (routeProvenFailure(input.context?.routeOutcomes, c.adapterId, c.model) ? ROUTE_FAILING_PENALTY : 0)
    : 0;

  // Cota de assinatura que expira no reset: sobra sobe, esgotamento desce.
  const quota = quotaPaceScore(pace) * (input.tier === 'critical' ? 0.5 : 1);

  const open = isCircuitOpen(c.adapterId, input.circuitOpen);
  const circuit = open ? -10_000 : 0;

  const total = table + quality + cost + diversity + preference + success + quota + circuit;
  return { table, quality, cost, diversity, preference, success, quota, circuit, total };
}

/** Origem da nota de qualidade do candidato: nexus-eval > benchmark oficial > neutro. */
function qualityKind(
  entry: RankedRouteEntry,
  catalog: MultiScoreInput['modelCatalog'],
): 'nexus-eval' | 'benchmark' | 'neutral' {
  const { c } = entry;
  if (hasAuthoritativeModelQuality(modelCatalogInfo(catalog, c.adapterId, c.model))) {
    return 'nexus-eval';
  }
  if (c.model && publishedCodingQuality(c.adapterId, c.model) !== null) {
    return 'benchmark';
  }
  return 'neutral';
}

/**
 * Re-rank hydrated candidates by multi-score. Stable sort: higher total first;
 * ties keep relative order (table order preserved).
 */
export function multiScoreRerank(input: MultiScoreInput): {
  ranked: RankedRouteEntry[];
  scored: ScoredRouteEntry[];
  note: string;
} {
  if (input.ranked.length === 0) {
    return { ranked: [], scored: [], note: '' };
  }

  const scored: ScoredRouteEntry[] = input.ranked.map((entry, index) => ({
    ...entry,
    score: scoreRouteCandidate(entry, index, input),
  }));

  // Drop hard-open circuits when any alternative exists.
  const anyClosed = scored.some((s) => s.score.circuit === 0);
  const filtered = anyClosed
    ? scored.filter((s) => s.score.circuit === 0)
    : scored;

  const sorted = [...filtered].sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    return 0;
  });

  const head = sorted[0];
  const noteParts: string[] = ['; multi-score'];
  if (head && head.score.diversity < 0) {
    noteParts.push(` diversity×${Math.abs(head.score.diversity / 18)}`);
  }
  if (head && head.score.preference > 0) {
    noteParts.push(' preference-boost');
  }
  if (head) {
    const kind = qualityKind(head, input.modelCatalog);
    if (kind === 'benchmark') {
      noteParts.push(' quality=benchmark-oficial');
    } else if (kind === 'neutral') {
      noteParts.push(' quality=neutra(sem benchmark)');
    }
  }
  if (anyClosed && filtered.length < scored.length) {
    noteParts.push(' circuit-open skipped');
  }
  if (head && head.score.quota !== 0) {
    const pace = input.context?.quotaPace?.get(head.c.adapterId);
    if (pace) {
      const sign = head.score.quota > 0 ? '+' : '';
      noteParts.push(
        `; cota: ${head.c.adapterId} ritmo ${pace.ratio.toFixed(1).replace('.', ',')}× ` +
          `(${sign}${Math.round(head.score.quota)})`,
      );
    }
  }
  // F-773: o termo aparece no recibo — quem liderou e quem perdeu por ele.
  const outcomes = sorted
    .map((entry) => ({
      entry,
      rate: routeSuccessRate(input.context?.routeOutcomes, entry.c.adapterId, entry.c.model),
    }))
    .filter((item): item is { entry: ScoredRouteEntry; rate: RouteSuccessRate } => item.rate !== null)
    .slice(0, 3);
  if (outcomes.length > 0) {
    noteParts.push(
      `; sucesso 14d: ${outcomes
        .map(({ entry, rate }) =>
          `${entry.c.adapterId}${entry.c.model ? `:${entry.c.model}` : ''} ${formatRouteSuccessRate(rate)}`,
        )
        .join(', ')}`,
    );
  }
  // Rota comprovadamente falha perdeu para alguém: o recibo diz quem foi
  // evitado. Se a líder também falha (única opção / todas falham), nada foi
  // evitado — fail-open, sem nota.
  const avoidedFailing = sorted
    .slice(1)
    .map((entry) => ({
      entry,
      rate: routeProvenFailure(input.context?.routeOutcomes, entry.c.adapterId, entry.c.model),
    }))
    .filter((item): item is { entry: ScoredRouteEntry; rate: RouteSuccessRate } => item.rate !== null)
    .slice(0, 3);
  if (
    head &&
    avoidedFailing.length > 0 &&
    routeProvenFailure(input.context?.routeOutcomes, head.c.adapterId, head.c.model) === null
  ) {
    noteParts.push(
      `; evitou rota falha: ${avoidedFailing
        .map(({ entry, rate }) =>
          `${entry.c.adapterId}${entry.c.model ? `:${entry.c.model}` : ''} ${formatRouteSuccessRate(rate)}`,
        )
        .join(', ')}`,
    );
  }

  return {
    ranked: sorted.map(({ score: _s, ...rest }) => rest),
    scored: sorted,
    note: noteParts.join(''),
  };
}

/**
 * Margem de custo/qualidade entre candidatos do mesmo tier. Posição na
 * tabela heurística não é uma medida de capacidade.
 */
export const TIE_MARGIN = 8;

export interface TieBreakInput {
  readonly ranked: RankedRouteEntry[];
  /** CLI → quantos panes do mesmo agente pai (e ele próprio) já a usam. */
  readonly useCounts: ReadonlyMap<string, number>;
  readonly tier: TaskTier;
  readonly modelCatalog: ModelCatalog;
  readonly context?: RouteContext;
  readonly circuitOpen?: MultiScoreInput['circuitOpen'];
  readonly margin?: number;
}

/**
 * "Melhor por tarefa, espalha no empate": entre os candidatos a até `margin`
 * pontos do topo e do mesmo tier, vence o menos usado. O chamador preserva
 * rankings medidos; aqui a ordem heurística só desempata uso equivalente.
 */
export function tieBreakByUse(input: TieBreakInput): {
  ranked: RankedRouteEntry[];
  note: string;
} {
  if (input.ranked.length < 2 || input.useCounts.size === 0) {
    return { ranked: input.ranked, note: '' };
  }
  const margin = input.margin ?? TIE_MARGIN;
  const scoreInput: Omit<MultiScoreInput, 'ranked'> = {
    tier: input.tier,
    modelCatalog: input.modelCatalog,
    circuitOpen: input.circuitOpen,
    // Sem histórico de missão: o total aqui é "qualidade da escolha", não
    // diversidade — a diversidade é justamente o que este passo decide.
    context: input.context
      ? { ...input.context, missionUsedAdapters: undefined, missionUseCounts: undefined }
      : undefined,
  };
  const totals = input.ranked.map(
    (candidate) => scoreRouteCandidate(candidate, 0, scoreInput).total,
  );
  const head = input.ranked[0]!;
  const floor = totals[0]! - margin;
  const uses = (adapterId: string): number => input.useCounts.get(adapterId) ?? 0;
  let best = 0;
  for (let index = 1; index < input.ranked.length; index += 1) {
    const candidate = input.ranked[index]!;
    if (candidate.fromTier !== head.fromTier) continue;
    if (isCircuitOpen(candidate.c.adapterId, input.circuitOpen)) continue;
    // F-1313 (revisão Fable): preferência é boost, não pin — o desempate por
    // uso vale também entre preferido e não-preferido do mesmo tier; o
    // roteador reaplica a preferência só entre os que não perdem no uso.
    if (totals[index]! < floor) continue;
    if (uses(input.ranked[index]!.c.adapterId) < uses(input.ranked[best]!.c.adapterId)) {
      best = index;
    }
  }
  if (best === 0) return { ranked: input.ranked, note: '' };
  const chosen = input.ranked[best]!;
  return {
    ranked: [chosen, ...input.ranked.filter((_, index) => index !== best)],
    note:
      `; desempate: ${chosen.c.adapterId} (${uses(chosen.c.adapterId)} aberto(s)) ` +
      `no lugar de ${head.c.adapterId} (${uses(head.c.adapterId)} aberto(s))`,
  };
}

/**
 * Build mission use counts from a list of adapter ids (panes).
 */
export function countAdapterUses(
  adapterIds: readonly string[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const id of adapterIds) {
    map.set(id, (map.get(id) ?? 0) + 1);
  }
  return map;
}

/**
 * Merge pane history + still-open route reservations into one use-count map.
 * Empty input returns undefined so the router keeps cold-start table order.
 */
export function mergeAdapterUseLists(
  ...lists: Array<readonly string[] | undefined>
): Map<string, number> | undefined {
  const merged = lists.flatMap((list) => list ?? []);
  return merged.length > 0 ? countAdapterUses(merged) : undefined;
}
