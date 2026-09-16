import { beforeEach, describe, expect, it } from 'vitest';
import { usePaneParkedStore } from './pane-parked-store';

describe('pane-parked-store', () => {
  beforeEach(() => {
    for (const paneId of usePaneParkedStore.getState().parked.keys()) {
      usePaneParkedStore.getState().clearParked(paneId);
    }
  });

  it('marks a pane parked with its info', () => {
    usePaneParkedStore
      .getState()
      .markParked('pane-1', { sessionId: 's1', parkedAt: 42, reason: 'idle' });

    expect(usePaneParkedStore.getState().parked.get('pane-1')).toEqual({
      sessionId: 's1',
      parkedAt: 42,
      reason: 'idle',
    });
  });

  it('clears one pane without touching others', () => {
    usePaneParkedStore
      .getState()
      .markParked('pane-1', { sessionId: 's1', parkedAt: 1, reason: 'idle' });
    usePaneParkedStore
      .getState()
      .markParked('pane-2', { sessionId: 's2', parkedAt: 2, reason: 'memory-pressure' });

    usePaneParkedStore.getState().clearParked('pane-1');

    expect(usePaneParkedStore.getState().parked.has('pane-1')).toBe(false);
    expect(usePaneParkedStore.getState().parked.has('pane-2')).toBe(true);
  });

  it('clearing an unknown pane is a no-op', () => {
    const before = usePaneParkedStore.getState().parked;
    usePaneParkedStore.getState().clearParked('never-parked');
    expect(usePaneParkedStore.getState().parked).toBe(before);
  });
});
