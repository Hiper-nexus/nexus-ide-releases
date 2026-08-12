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
