import { expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import { deliverExclusiveHeldNotice, exclusiveHeldNoticeText } from './heavy-command-held-notice';
import type { HeavyExclusiveHeldReport } from './heavy-command-permit';

const coordination = testProjectScope();
const worktree = { ...coordination, checkoutId: 'wt', rootRealPath: '/worktrees/a' };
const report = (overrides: Partial<HeavyExclusiveHeldReport> = {}): HeavyExclusiveHeldReport => ({
  root: '/worktrees/a', kind: 'build', label: 'npm run build', sessionId: 'maestro', paneId: 'pane-1', missionId: 'spoofed',
  heldMs: 12 * 60_000, waiting: 18, waitingSessionIds: ['worker-1', 'worker-2', 'loose'], waitingMissionIds: ['spoofed'], ...overrides,
});

it('names the holder, how long and how many wait, and says the slot stays exclusive', () => {
  const text = exclusiveHeldNoticeText(report());
  expect(text).toMatch(/^\[fila-pesada\] build \(npm run build\) do pane pane-1 .* há 12 min, com 18 comando\(s\)/u);
  expect(text).toContain('continua exclusiva');
});

it('notifies each running mission once, through the coordination store of the Main session info', () => {
  const submit = vi.fn();
  const sessions: Record<string, { missionId?: string; scope: typeof coordination; coordinationScope?: typeof coordination }> = {
    maestro: { missionId: 'mission-a', scope: coordination },
    'worker-1': { missionId: 'mission-a', scope: worktree, coordinationScope: coordination },
    'worker-2': { missionId: 'mission-ended', scope: worktree, coordinationScope: coordination },
    loose: { scope: coordination },
  };
  const delivered = deliverExclusiveHeldNotice(report(), {
    session: id => sessions[id], missionRunning: (_scope, missionId) => missionId !== 'mission-ended', submit,
  });
  expect(delivered).toBe(1);
  expect(submit).toHaveBeenCalledOnce();
  expect(submit).toHaveBeenCalledWith(coordination, 'mission-a', expect.stringContaining('[fila-pesada]'));
  // The request's missionId is never trusted on its own.
  expect(submit).not.toHaveBeenCalledWith(expect.anything(), 'spoofed', expect.anything());
});

it('a failing store does not silence the other missions', () => {
  const submit = vi.fn((_scope: unknown, missionId: string) => { if (missionId === 'mission-a') throw new Error('store'); });
  const delivered = deliverExclusiveHeldNotice(report({ waitingSessionIds: ['worker-b'] }), {
    session: id => id === 'maestro' ? { missionId: 'mission-a', scope: coordination } : { missionId: 'mission-b', scope: coordination },
    missionRunning: () => true, submit,
  });
  expect(delivered).toBe(1);
  expect(submit).toHaveBeenCalledTimes(2);
});
