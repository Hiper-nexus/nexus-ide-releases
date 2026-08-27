import { describe, expect, it } from 'vitest';
import { retryTargetMsForLimit } from './failover-retry-policy';

describe('retryTargetMsForLimit', () => {
  it('auth without a sibling does not retry the same dead credential', () => {
    expect(
      retryTargetMsForLimit({
        kind: 'auth',
        ownUnblockAtMs: 160_000,
      }),
    ).toBeUndefined();
  });

  it('auth still waits for a sibling that will unblock', () => {
    expect(
      retryTargetMsForLimit({
        kind: 'auth',
        ownUnblockAtMs: 1_000_000,
        nextUnblockAtMs: 130_000,
      }),
    ).toBe(130_000);
  });

  it('rate-limit keeps espera-pela-irmã (min of own vs sibling)', () => {
    expect(
      retryTargetMsForLimit({
        kind: 'rate-limit',
        ownUnblockAtMs: 160_000,
        nextUnblockAtMs: 500_000,
      }),
    ).toBe(160_000);
    expect(
      retryTargetMsForLimit({
        kind: 'rate-limit',
        ownUnblockAtMs: 500_000,
        nextUnblockAtMs: 130_000,
      }),
    ).toBe(130_000);
  });
});
