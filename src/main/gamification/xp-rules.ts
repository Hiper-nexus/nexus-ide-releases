import type {
  GamificationTier,
  XpEventKind,
} from '../../shared/gamification-types';

/**
 * Regras de XP v1 — TODAS as constantes calibráveis vivem aqui, versionadas.
 * Rebalancear = subir RULE_VERSION e recomputar o agregado dos eventos
 * (nunca rebaixando tier já alcançado — piso aplicado no fold da borda).
 * Lógica pura (sem electron) — unit-testável.
 */

export const RULE_VERSION = 1;

/** XP base por tipo de entrega. Token gasto NÃO é (e nunca será) um kind. */
export const BASE_POINTS: Record<XpEventKind, number> = {
  mission_green: 25_000,
  mission_done: 10_000,
  handoff_green: 8_000,
  handoff_success: 3_000,
  task_done: 5_000,
  media_generated: 1_000,
};

/**
 * Escala pelo esforço/tier da tarefa (proxy persistido da decisão do router:
 * mission_panes.effort). Anti-farm: migalha rende migalha.
 */
export function effortScale(effort?: string | null): number {
  switch (effort) {
    case 'low':
      return 0.5;
    case 'high':
      return 1.8;
    case 'medium':
    default:
      return 1;
  }
}

/** Retorno decrescente diário: 5 inteiras, 5 pela metade, resto a 1/4. */
export function diminishingFactor(priorTodayCount: number): number {
  if (priorTodayCount < 5) return 1;
  if (priorTodayCount < 10) return 0.5;
  return 0.25;
}

/**
 * Bandas FIXAS de custo eficiente por effort (USD por missão) — comparar com
 * a média do próprio usuário puniria quem melhora e sofre cold start.
 */
const EFFICIENT_COST_BANDS: Record<string, number> = {
  low: 0.1,
  medium: 0.75,
  high: 3.0,
};

const EFFICIENCY_BONUS = 0.5; // até +50% sobre o XP base da missão verde

export function efficiencyBonus(
  kind: XpEventKind,
  effort: string | null | undefined,
  costUsd: number | null | undefined,
): number {
  if (kind !== 'mission_green') return 0;
  if (typeof costUsd !== 'number' || costUsd < 0) return 0;
  const band = effort ? EFFICIENT_COST_BANDS[effort] : undefined;
  if (band === undefined) return 0;
  return costUsd <= band ? EFFICIENCY_BONUS : 0;
}

/** Escada exponencial (~3–4× por banda). */
export const TIER_THRESHOLDS: Array<{
  tier: GamificationTier;
  minPower: number;
}> = [
  { tier: 'RECRUTA', minPower: 0 },
  { tier: 'INICIADO', minPower: 100_000 },
  { tier: 'VETERANO', minPower: 400_000 },
  { tier: 'ELITE', minPower: 1_500_000 },
  { tier: 'MAESTRO', minPower: 6_000_000 },
  { tier: 'LENDA', minPower: 25_000_000 },
];

/** Ao cruzar isto em LENDA o jogador pode transcender (prestígio). */
export const PRESTIGE_THRESHOLD = 100_000_000;

export function tierForPower(power: number): GamificationTier {
  let current: GamificationTier = 'RECRUTA';
  for (const { tier, minPower } of TIER_THRESHOLDS) {
    if (power >= minPower) current = tier;
  }
  return current;
}

export function nextTierAt(power: number): number | null {
  for (const { minPower } of TIER_THRESHOLDS) {
    if (power < minPower) return minPower;
  }
  return PRESTIGE_THRESHOLD;
}
