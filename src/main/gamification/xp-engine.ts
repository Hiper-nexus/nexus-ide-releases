import type {
  GamificationTier,
  OperatorBranch,
  StoredXpEvent,
  XpEventInput,
} from '../../shared/gamification-types';
import {
  BASE_POINTS,
  diminishingFactor,
  efficiencyBonus,
  effortScale,
  nextTierAt,
  tierForPower,
} from './xp-rules';

/**
 * Engine puro de XP: evento → pontos, eventos → agregado. Sem electron, sem
 * IO — a borda (gamification-service, Parte 3) resolve inputs e persiste.
 */

export const BRANCH_MIN_DELIVERIES = 20;
export const BRANCH_DOMINANCE = 0.45;

export function computePoints(
  input: XpEventInput,
  priorTodayCount: number,
): number {
  // Retro (replay do histórico): entregas antigas não têm evidência —
  // "verde" histórico vale o peso da entrega simples equivalente.
  const kind =
    input.retro && input.kind === 'mission_green'
      ? 'mission_done'
      : input.retro && input.kind === 'handoff_green'
      ? 'handoff_success'
      : input.kind;
  const base = BASE_POINTS[kind];
  const scaled = base * effortScale(input.effort);
  const diminished = scaled * diminishingFactor(priorTodayCount);
  const bonus = input.retro
    ? 0
    : efficiencyBonus(kind, input.effort, input.costUsd);
  return Math.max(0, Math.round(diminished * (1 + bonus)));
}

/** Ramo do mascote a partir dos counters de entrega por categoria. */
export function branchFor(counters: Record<string, number>): OperatorBranch {
  const guardiao = counters.deliveries_reviewer ?? 0;
  const forja = counters.deliveries_executor ?? 0;
  const scout =
    (counters.deliveries_scout ?? 0) + (counters.deliveries_architect ?? 0);
  const total = guardiao + forja + scout;
  if (total < BRANCH_MIN_DELIVERIES) return 'base';
  const shares: Array<[OperatorBranch, number]> = [
    ['guardiao', guardiao / total],
    ['forja', forja / total],
    ['scout', scout / total],
  ];
  shares.sort((a, b) => b[1] - a[1]);
  return shares[0][1] >= BRANCH_DOMINANCE ? shares[0][0] : 'base';
}

export interface Aggregate {
  powerLevel: number;
  tier: GamificationTier;
  nextTierAt: number | null;
  branch: OperatorBranch;
  counters: Record<string, number>;
}

export function foldAggregate(
  events: StoredXpEvent[],
  _prestige: number,
): Aggregate {
  let power = 0;
  const counters: Record<string, number> = {};
  const bump = (key: string) => {
    counters[key] = (counters[key] ?? 0) + 1;
  };
  for (const ev of events) {
    power += ev.points;
    bump(ev.kind);
    if (ev.agentCategory) bump(`deliveries_${ev.agentCategory}`);
  }
  return {
    powerLevel: power,
    tier: tierForPower(power),
    nextTierAt: nextTierAt(power),
    branch: branchFor(counters),
    counters,
  };
}
