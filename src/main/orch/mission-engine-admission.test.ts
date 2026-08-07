import { describe, expect, it } from 'vitest';
import { evaluateMissionAdmission } from './mission-engine-admission';

describe('evaluateMissionAdmission', () => {
  it.each([
    [false, false, false, 'authority-missing'],
    [false, false, true, 'authority-missing'],
    [false, true, false, 'authority-missing'],
    [false, true, true, 'authority-missing'],
    [true, false, false, 'kickoff-receipt-missing'],
    [true, false, true, 'kickoff-receipt-missing'],
    [true, true, false, 'orchestrator-not-live'],
    [true, true, true, undefined],
  ] as const)(
    'evaluates authority=%s receipt=%s live=%s',
    (
      hasDispatchAuthority,
      hasCurrentKickoffReceipt,
      orchestratorLive,
      expectedCode,
    ) => {
      const result = evaluateMissionAdmission({
        hasDispatchAuthority,
        hasCurrentKickoffReceipt,
        orchestratorLive,
      });

      expect(result).toEqual(
        expectedCode === undefined
          ? { ok: true }
          : { ok: false, code: expectedCode },
      );
    },
  );

  it('rejects unknown admission fields instead of widening the boundary', () => {
    expect(() =>
      evaluateMissionAdmission({
        hasDispatchAuthority: true,
        hasCurrentKickoffReceipt: true,
        orchestratorLive: true,
        dispatchToken: 'must-not-cross',
      } as never),
    ).toThrow();
  });
});
