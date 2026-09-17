import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dataTaps: new Set<(sessionId: string, data: string) => void>(),
  exitTaps: new Set<(sessionId: string) => void>(),
}));

vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: () => ({ adapterId: 'claude', paneId: 'p1' }),
  tapSessionData: (cb: (s: string, d: string) => void) => {
    h.dataTaps.add(cb);
    return () => h.dataTaps.delete(cb);
  },
  tapSessionExit: (cb: (s: string) => void) => {
    h.exitTaps.add(cb);
    return () => h.exitTaps.delete(cb);
  },
}));
vi.mock('../orch/agent-status', () => ({
  applyScreenDetectionEvent: vi.fn(),
}));

import {
  __resetAgentScreenDetectionForTests,
  activeScreenText,
  startAgentScreenDetection,
  tapActiveScreenDetections,
} from './detector';

describe('active-detector accessors', () => {
  afterEach(() => {
    __resetAgentScreenDetectionForTests();
    vi.useRealTimers();
  });

  it('null quando a detecção não está ativa', () => {
    expect(tapActiveScreenDetections(() => {})).toBeNull();
    expect(activeScreenText('s1')).toBeNull();
  });

  it('tap recebe records e activeScreenText devolve a cauda', () => {
    vi.useFakeTimers();
    const dispose = startAgentScreenDetection();
    const records: unknown[] = [];
    const untap = tapActiveScreenDetections((r) => records.push(r));
    expect(untap).not.toBeNull();
    for (const tap of h.dataTaps) tap('s1', 'hello screen\n');
    vi.advanceTimersByTime(200);
    expect(records.length).toBeGreaterThan(0);
    expect(activeScreenText('s1')).toContain('hello screen');
    untap?.();
    const count = records.length;
    for (const tap of h.dataTaps) tap('s1', 'more\n');
    vi.advanceTimersByTime(200);
    expect(records.length).toBe(count);
    dispose();
    expect(tapActiveScreenDetections(() => {})).toBeNull();
  });
});
