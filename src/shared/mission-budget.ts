/**
 * Mission-scoped budget dashboard: pure aggregation over intent contract
 * spend counters (and optional pane cost hints). No I/O.
 */

import type { Mission } from './orch-types';
import type { MissionIntentContract } from './mission-intent';

export interface MissionBudgetSnapshot {
  readonly missionId: string;
  readonly hasContract: boolean;
  readonly spentSteps: number;
  readonly maxSteps: number;
  readonly spentTokens: number;
  readonly maxTokens: number;
  readonly maxWorkers: number;
  readonly remainingSteps: number;
  readonly remainingTokens: number;
  readonly stepsRatio: number;
  readonly tokensRatio: number;
  readonly risk: string | null;
  readonly level: 'ok' | 'warn' | 'over';
  /** Compact label for rail/chips, e.g. "1.2k/20k tok · 3/500". */
  readonly label: string;
}

function formatTok(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n / 1_000)}k`;
}

export function summarizeMissionBudget(
  mission: Pick<Mission, 'id' | 'intentContract'>,
): MissionBudgetSnapshot {
  const contract: MissionIntentContract | undefined = mission.intentContract;
  if (!contract) {
    return {
      missionId: mission.id,
      hasContract: false,
      spentSteps: 0,
      maxSteps: 0,
      spentTokens: 0,
      maxTokens: 0,
      maxWorkers: 0,
      remainingSteps: 0,
      remainingTokens: 0,
      stepsRatio: 0,
      tokensRatio: 0,
      risk: null,
      level: 'ok',
      label: '—',
    };
  }

  const maxSteps = contract.budgets.maxSteps ?? 500;
  const maxTokens = contract.budgets.executionTokens;
  const spentSteps = contract.spentSteps ?? 0;
  const spentTokens = contract.spentTokens ?? 0;
  const maxWorkers = contract.budgets.maxWorkers;
  const remainingSteps = Math.max(0, maxSteps - spentSteps);
  const remainingTokens = Math.max(0, maxTokens - spentTokens);
  const stepsRatio = maxSteps > 0 ? Math.min(1, spentSteps / maxSteps) : 0;
  const tokensRatio = maxTokens > 0 ? Math.min(1, spentTokens / maxTokens) : 0;
  const peak = Math.max(stepsRatio, tokensRatio);
  const level: MissionBudgetSnapshot['level'] =
    peak >= 1 ? 'over' : peak >= 0.8 ? 'warn' : 'ok';

  const label =
    maxTokens > 0
      ? `${formatTok(spentTokens)}/${formatTok(maxTokens)} tok · ${spentSteps}/${maxSteps}`
      : `${spentSteps}/${maxSteps} steps`;

  return {
    missionId: mission.id,
    hasContract: true,
    spentSteps,
    maxSteps,
    spentTokens,
    maxTokens,
    maxWorkers,
    remainingSteps,
    remainingTokens,
    stepsRatio,
    tokensRatio,
    risk: contract.risk,
    level,
    label,
  };
}

/** Aggregate budget across many missions (workspace dashboard strip). */
export function summarizeWorkspaceMissionBudgets(
  missions: readonly Pick<Mission, 'id' | 'intentContract' | 'status'>[],
): {
  readonly activeCount: number;
  readonly totalSpentTokens: number;
  readonly totalMaxTokens: number;
  readonly totalSpentSteps: number;
  readonly label: string;
} {
  let totalSpentTokens = 0;
  let totalMaxTokens = 0;
  let totalSpentSteps = 0;
  let activeCount = 0;
  for (const mission of missions) {
    if (mission.status === 'done' || mission.status === 'failed') continue;
    const snap = summarizeMissionBudget(mission);
    if (!snap.hasContract) continue;
    activeCount += 1;
    totalSpentTokens += snap.spentTokens;
    totalMaxTokens += snap.maxTokens;
    totalSpentSteps += snap.spentSteps;
  }
  const label =
    activeCount === 0
      ? '0 missões com budget'
      : `${activeCount} missões · ${formatTok(totalSpentTokens)}/${formatTok(totalMaxTokens)} tok`;
  return {
    activeCount,
    totalSpentTokens,
    totalMaxTokens,
    totalSpentSteps,
    label,
  };
}
