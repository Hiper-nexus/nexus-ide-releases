import { describe, expect, it } from 'vitest';
import type { PaneSnapshot } from '../../shared/orch-types';
import {
  activeSameCheckoutWorker,
  reserveWorkerSpawnSlot,
  withSameCheckoutWorkerContract,
} from './tools-panes';
import { testProjectScope } from './__tests__/scope-fixture';
import { compileIntentContract } from '../../shared/mission-intent';

function pane(
  state: PaneSnapshot['state'],
  role: PaneSnapshot['role'] = 'worker',
  missionId = 'mission-a',
  checkoutRoot = '/repo/a',
): PaneSnapshot {
  return {
    paneId: `${missionId}-${role}-${state}`,
    sessionId: 'session-a',
    title: 'worker',
    kind: 'cli-agent',
    state,
    role,
    missionId,
    executionScope: testProjectScope({ rootRealPath: checkoutRoot }),
  };
}

describe('pre-contract same-checkout delegation', () => {
  it('blocks another active worker anywhere in the same checkout', () => {
    expect(activeSameCheckoutWorker([
      pane('idle'),
      pane('busy', 'orchestrator'),
      pane('busy', 'worker', 'mission-b', '/repo/b'),
    ], '/repo/a')).toBeNull();

    expect(activeSameCheckoutWorker([
      pane('busy'),
    ], '/repo/a')?.state).toBe('busy');
    expect(activeSameCheckoutWorker([
      pane('spawning', 'worker', 'mission-b'),
    ], '/repo/a')?.state).toBe('spawning');
  });

  it('injects a non-destructive ownership contract into the worker prompt', () => {
    const prompt = withSameCheckoutWorkerContract('Corrija o fluxo de voz.');

    expect(prompt).toContain('executionMode=\`same_checkout\`');
    expect(prompt).toContain('não use stash, reset, checkout');
    expect(prompt).toContain('Corrija o fluxo de voz.');
    expect(prompt).toContain('nexus_handoff_submit');
  });

  it('serializes maxWorkers reservations across concurrent spawn attempts', () => {
    const scope = testProjectScope();
    const base = compileIntentContract({ goal: 'ship', intentVersion: 1 });
    const contract = {
      ...base,
      budgets: { ...base.budgets, maxWorkers: 1 },
    };

    const first = reserveWorkerSpawnSlot({
      scope,
      missionId: 'mission-race',
      contract,
      currentWorkerCount: 0,
      allowedTools: ['file_read'],
    });
    expect(first.ok).toBe(true);
    const second = reserveWorkerSpawnSlot({
      scope,
      missionId: 'mission-race',
      contract,
      currentWorkerCount: 0,
      allowedTools: ['file_read'],
    });
    expect(second).toMatchObject({ ok: false, code: 'budget_exhausted' });

    if (first.ok) first.release();
    const afterRelease = reserveWorkerSpawnSlot({
      scope,
      missionId: 'mission-race',
      contract,
      currentWorkerCount: 0,
      allowedTools: ['file_read'],
    });
    expect(afterRelease.ok).toBe(true);
    if (afterRelease.ok) afterRelease.release();
  });
});
