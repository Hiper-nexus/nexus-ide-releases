// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  summarizeMissionBudget,
  summarizeWorkspaceMissionBudgets,
} from './mission-budget';
import { compileIntentContract } from './mission-intent';
import type { Mission } from './orch-types';

function mission(
  over: Partial<Mission> & { id: string },
): Mission {
  return {
    title: over.title ?? over.id,
    description: '',
    status: 'running',
    milestones: [],
    learnings: '',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('mission budget dashboard', () => {
  it('returns empty label without contract', () => {
    const snap = summarizeMissionBudget(mission({ id: 'm1' }));
    expect(snap.hasContract).toBe(false);
    expect(snap.label).toBe('—');
  });

  it('formats spent tokens and steps from intent contract', () => {
    const contract = compileIntentContract({
      goal: 'ship feature',
      intentVersion: 1,
    });
    const withSpend = {
      ...contract,
      spentSteps: 12,
      spentTokens: 2_400,
    };
    const snap = summarizeMissionBudget(
      mission({ id: 'm2', intentContract: withSpend }),
    );
    expect(snap.hasContract).toBe(true);
    expect(snap.spentSteps).toBe(12);
    expect(snap.spentTokens).toBe(2_400);
    expect(snap.label).toMatch(/tok/);
    expect(snap.level).toBe('ok');
  });

  it('marks warn/over near ceilings', () => {
    const contract = compileIntentContract({ goal: 'x', intentVersion: 1 });
    const near = {
      ...contract,
      spentSteps: Math.ceil((contract.budgets.maxSteps ?? 500) * 0.85),
      spentTokens: Math.ceil(contract.budgets.executionTokens * 0.9),
    };
    expect(summarizeMissionBudget(mission({ id: 'm3', intentContract: near })).level).toBe(
      'warn',
    );
    const over = {
      ...contract,
      spentSteps: contract.budgets.maxSteps ?? 500,
      spentTokens: contract.budgets.executionTokens,
    };
    expect(summarizeMissionBudget(mission({ id: 'm4', intentContract: over })).level).toBe(
      'over',
    );
  });

  it('aggregates active missions for workspace strip', () => {
    const c = compileIntentContract({ goal: 'a', intentVersion: 1 });
    const agg = summarizeWorkspaceMissionBudgets([
      mission({
        id: 'a',
        status: 'running',
        intentContract: { ...c, spentTokens: 1000, spentSteps: 2 },
      }),
      mission({ id: 'b', status: 'done', intentContract: c }),
      mission({ id: 'c', status: 'pending' }),
    ]);
    expect(agg.activeCount).toBe(1);
    expect(agg.totalSpentTokens).toBe(1000);
    expect(agg.label).toMatch(/1 missões/);
  });
});
