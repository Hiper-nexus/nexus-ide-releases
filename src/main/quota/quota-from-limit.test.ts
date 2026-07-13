import { describe, expect, it } from 'vitest';
import {
  applyLimitHitToWindows,
  windowsFromCooldown,
  windowsFromLimitHit,
} from './quota-from-limit';
import { defaultUnknownWindows } from './quota-normalize';

describe('quota-from-limit', () => {
  it('maps rate-limit on codex to 5h exhausted window', () => {
    const now = 5_000_000;
    const w = windowsFromLimitHit(
      { kind: 'rate-limit', reason: '5h', cooldownMs: 5 * 3600_000 },
      'codex',
      now,
    );
    expect(w[0]?.kind).toBe('hours');
    expect(w[0]?.usedRatio).toBe(1);
    expect(w[0]?.source).toBe('limit-hit');
  });

  it('maps quota kind to weekly exhausted', () => {
    const w = windowsFromLimitHit(
      { kind: 'quota', reason: 'out', cooldownMs: 12 * 3600_000 },
      'claude',
      1,
    );
    expect(w[0]?.kind).toBe('weekly');
    expect(w[0]?.usedRatio).toBe(1);
  });

  it('merges limit hit without inventing other zeros', () => {
    const base = defaultUnknownWindows('claude');
    const next = applyLimitHitToWindows(
      base,
      { kind: 'rate-limit', reason: 'x', cooldownMs: 3600_000 },
      'claude',
      10_000,
    );
    const session = next.find((x) => x.kind === 'session');
    expect(session?.usedRatio).toBe(1);
    const weekly = next.find((x) => x.kind === 'weekly');
    expect(weekly?.usedRatio).toBeNull();
  });

  it('cooldown window empties when expired', () => {
    expect(windowsFromCooldown(100, 'codex', 200)).toEqual([]);
  });
});
