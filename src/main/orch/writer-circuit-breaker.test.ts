import { afterEach, describe, expect, it } from 'vitest';
import {
  WRITER_CIRCUIT_BREAK_FAILURES,
  decideWriterCircuitAction,
  recordWriterConnectFailure,
  resetWriterCircuitForTests,
  writerCircuitBroken,
} from './writer-circuit-breaker';

afterEach(() => {
  resetWriterCircuitForTests();
});

describe('writer circuit-break 3', () => {
  it('trips on the same role or the same adapter after 3 failures', () => {
    const roleKey = {
      missionId: 'm1',
      role: 'writer-3',
      adapterId: 'kimi',
    };
    expect(WRITER_CIRCUIT_BREAK_FAILURES).toBe(3);
    expect(recordWriterConnectFailure(roleKey)).toBe(1);
    expect(recordWriterConnectFailure(roleKey)).toBe(2);
    expect(writerCircuitBroken(roleKey)).toBe(false);
    expect(recordWriterConnectFailure(roleKey)).toBe(3);
    expect(writerCircuitBroken(roleKey)).toBe(true);
    expect(
      writerCircuitBroken({
        missionId: 'm1',
        role: 'writer-3',
        adapterId: 'claude',
      }),
    ).toBe(false);
  });

  it('remints when a successor is authed; otherwise skip-silent', () => {
    expect(
      decideWriterCircuitAction({ attempts: 2, successorAuthed: true }),
    ).toBe('retry');
    expect(
      decideWriterCircuitAction({ attempts: 3, successorAuthed: true }),
    ).toBe('remint');
    expect(
      decideWriterCircuitAction({ attempts: 3, successorAuthed: false }),
    ).toBe('skip-silent');
  });
});
