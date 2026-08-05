import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetWaveConcurrencyVerdictForTests,
  waveConcurrencyVerdictSignature,
  shouldEmitWaveConcurrencyVerdict,
} from './wave-concurrency-verdict';
import type { WaveConcurrencyDiagnosis } from './mission-scheduler';

function diagnosis(
  overrides: Partial<WaveConcurrencyDiagnosis> = {},
): WaveConcurrencyDiagnosis {
  return {
    effectiveCap: 2,
    binding: 'configured',
    readyCount: 11,
    admittedCount: 2,
    deferredByCap: 9,
    phase: 'throttled',
    operatorRaisable: true,
    summary: 'onda limitada a 2 de 11 unidades elegíveis',
    ...overrides,
  };
}

describe('wave concurrency verdict — edge-triggered visibility', () => {
  beforeEach(() => {
    resetWaveConcurrencyVerdictForTests();
  });

  it('emits the first verdict a mission produces', () => {
    expect(shouldEmitWaveConcurrencyVerdict('m1', diagnosis())).toBe(true);
  });

  it('does NOT re-emit an unchanged verdict — a 5s tick must not flood', () => {
    expect(shouldEmitWaveConcurrencyVerdict('m1', diagnosis())).toBe(true);
    expect(shouldEmitWaveConcurrencyVerdict('m1', diagnosis())).toBe(false);
    expect(shouldEmitWaveConcurrencyVerdict('m1', diagnosis())).toBe(false);
  });

  it('re-emits when the wave widens or narrows', () => {
    expect(shouldEmitWaveConcurrencyVerdict('m1', diagnosis())).toBe(true);
    expect(
      shouldEmitWaveConcurrencyVerdict('m1', diagnosis({ effectiveCap: 8 })),
    ).toBe(true);
  });

  it('re-emits when the mission leaves a throttled phase', () => {
    expect(shouldEmitWaveConcurrencyVerdict('m1', diagnosis())).toBe(true);
    expect(
      shouldEmitWaveConcurrencyVerdict(
        'm1',
        diagnosis({ phase: 'sequential', binding: 'none', deferredByCap: 0 }),
      ),
    ).toBe(true);
  });

  it('re-emits when the eligible backlog changes even at the same cap', () => {
    // Draining 11 → 4 eligible units at a fixed cap is real progress the
    // operator should see; suppressing it would freeze a stale verdict.
    expect(shouldEmitWaveConcurrencyVerdict('m1', diagnosis())).toBe(true);
    expect(
      shouldEmitWaveConcurrencyVerdict('m1', diagnosis({ readyCount: 4 })),
    ).toBe(true);
  });

  it('tracks missions independently', () => {
    expect(shouldEmitWaveConcurrencyVerdict('m1', diagnosis())).toBe(true);
    expect(shouldEmitWaveConcurrencyVerdict('m2', diagnosis())).toBe(true);
    expect(shouldEmitWaveConcurrencyVerdict('m1', diagnosis())).toBe(false);
  });

  it('signature ignores prose so a reworded summary never re-fires', () => {
    expect(
      waveConcurrencyVerdictSignature(diagnosis({ summary: 'a' })),
    ).toBe(waveConcurrencyVerdictSignature(diagnosis({ summary: 'b' })));
  });
});
