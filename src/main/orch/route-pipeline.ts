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
import type { RankedRouteEntry, RouteContext, TaskTier } from './task-router';

export interface ScoreBreakdown {
  table: number;
  quality: number;
  cost: number;
  diversity: number;
  preference: number;
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
  // Table position stays primary so cold ladder order is stable; multi-score
  // nudges diversity/circuit without inventing a second router.
  const table = Math.max(0, 60 - index * 4);

  const info = modelCatalogInfo(input.modelCatalog, c.adapterId, c.model);
  const authoritativeQuality = hasAuthoritativeModelQuality(info)
    ? info?.quality
    : undefined;
  const qualityRaw =
    authoritativeQuality?.coding ??
    authoritativeQuality?.overall ??
    (entry.evaluated ? 12 : 6);
  const quality = Math.min(24, Number(qualityRaw) || 6);

  const costRank = modelRoutingRank(info);
  const cost =
    input.tier === 'trivial' || input.tier === 'easy'
      ? -costRank * 4
      : input.tier === 'medium'
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

  const open = isCircuitOpen(c.adapterId, input.circuitOpen);
  const circuit = open ? -10_000 : 0;

  const total = table + quality + cost + diversity + preference + circuit;
  return { table, quality, cost, diversity, preference, circuit, total };
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
  if (anyClosed && filtered.length < scored.length) {
    noteParts.push(' circuit-open skipped');
  }

  return {
    ranked: sorted.map(({ score: _s, ...rest }) => rest),
    scored: sorted,
    note: noteParts.join(''),
  };
}

/**
 * Faixa de empate do desempate por uso (spawn da mão do operador, 25/09):
 * ~2 posições da tabela, que desce 4 pontos por posição.
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
 * pontos do topo, vence o menos usado; fora da faixa ninguém sobe. Diferente
 * da atenuação de missão (−18 por uso), nunca troca um vencedor claro.
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
    (candidate, index) => scoreRouteCandidate(candidate, index, scoreInput).total,
  );
  const floor = totals[0]! - margin;
  const uses = (adapterId: string): number => input.useCounts.get(adapterId) ?? 0;
  let best = 0;
  for (let index = 1; index < input.ranked.length; index += 1) {
    if (totals[index]! < floor) continue;
    if (uses(input.ranked[index]!.c.adapterId) < uses(input.ranked[best]!.c.adapterId)) {
      best = index;
    }
  }
  if (best === 0) return { ranked: input.ranked, note: '' };
  const head = input.ranked[0]!;
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
