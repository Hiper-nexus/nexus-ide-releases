import { describe, expect, it } from 'vitest';
import type { PaneSnapshot } from '../../shared/orch-types';
import {
  activeSameCheckoutWorker,
  withSameCheckoutWorkerContract,
} from './tools-panes';
import { testProjectScope } from './__tests__/scope-fixture';

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
});
