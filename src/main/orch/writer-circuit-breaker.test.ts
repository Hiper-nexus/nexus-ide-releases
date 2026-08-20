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

describe('writer circuit-break', () => {
  it('trips on the same role or the same adapter after N failures', () => {
    const roleKey = {
      missionId: 'm1',
      role: 'writer-3',
      adapterId: 'kimi',
    };
    for (let i = 1; i < WRITER_CIRCUIT_BREAK_FAILURES; i += 1) {
      expect(recordWriterConnectFailure(roleKey)).toBe(i);
      expect(writerCircuitBroken(roleKey)).toBe(false);
    }
    expect(recordWriterConnectFailure(roleKey)).toBe(WRITER_CIRCUIT_BREAK_FAILURES);
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
      decideWriterCircuitAction({
        attempts: WRITER_CIRCUIT_BREAK_FAILURES - 1,
        successorAuthed: true,
      }),
    ).toBe('retry');
    expect(
      decideWriterCircuitAction({
        attempts: WRITER_CIRCUIT_BREAK_FAILURES,
        successorAuthed: true,
      }),
    ).toBe('remint');
    expect(
      decideWriterCircuitAction({
        attempts: WRITER_CIRCUIT_BREAK_FAILURES,
        successorAuthed: false,
      }),
    ).toBe('skip-silent');
  });
});
