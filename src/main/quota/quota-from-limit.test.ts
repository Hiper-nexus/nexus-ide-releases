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
    const hours = next.find((x) => x.kind === 'hours');
    expect(hours?.usedRatio).toBe(1);
    const weekly = next.find((x) => x.kind === 'weekly');
    expect(weekly?.usedRatio).toBeNull();
  });

  it('cooldown window empties when expired', () => {
    expect(windowsFromCooldown(100, 'codex', 200)).toEqual([]);
  });

  it('auth cooldown does not masquerade as 100% quota', () => {
    const now = 10_000;
    expect(
      windowsFromCooldown(now + 60_000, 'claude', now, 'auth'),
    ).toEqual([]);
  });

  it('transient hits paint no usage window (blip, not quota)', () => {
    const now = 10_000;
    const w = windowsFromLimitHit(
      { kind: 'transient', reason: '503 overloaded', cooldownMs: 45_000 },
      'claude',
      now,
      now,
    );
    expect(w).toEqual([]);
    // Merge não inventa esgotamento a partir de um blip.
    const merged = applyLimitHitToWindows(
      defaultUnknownWindows('claude'),
      { kind: 'transient', reason: '503 overloaded', cooldownMs: 45_000 },
      'claude',
      now,
      now,
    );
    expect(merged.find((x) => x.usedRatio === 1)).toBeUndefined();
  });

  it('maps quota-kind weekly exhaustion (not 5h) for weekly limit hits', () => {
    const now = 10_000;
    const w = windowsFromLimitHit(
      { kind: 'quota', reason: 'weekly usage limit exceeded', cooldownMs: 12 * 3600_000 },
      'claude',
      now,
      now,
    );
    expect(w[0]?.kind).toBe('weekly');
    expect(w[0]?.label).toBe('Semanal');
    expect(w[0]?.usedRatio).toBe(1);
  });

  it('uses hitAt for stable resetsAt and drops when past cooldown', () => {
    const hitAt = 10_000;
    const cooldownMs = 5_000;
    const hit = {
      kind: 'rate-limit' as const,
      reason: 'x',
      cooldownMs,
    };
    const mid = windowsFromLimitHit(hit, 'claude', hitAt + 1_000, hitAt);
    expect(mid[0]?.resetsAt).toBe(hitAt + cooldownMs);
    expect(mid[0]?.usedRatio).toBe(1);
    // Rebuilding later still anchors to hitAt, not a sliding now+cooldown
    const later = windowsFromLimitHit(hit, 'claude', hitAt + 2_000, hitAt);
    expect(later[0]?.resetsAt).toBe(hitAt + cooldownMs);
    expect(windowsFromLimitHit(hit, 'claude', hitAt + cooldownMs + 1, hitAt)).toEqual(
      [],
    );
  });
});

  it('rate-limit com cooldown maior que 5h pinta a janela Semanal, não a de 5h', () => {
    // Caso de campo: "5 Horas 100% · 10h16m" é impossível por definição —
    // reset além da janela é claim de classe semanal.
    const now = 5_000_000;
    const windows = windowsFromLimitHit(
      { kind: 'rate-limit', reason: 'resets 10h', cooldownMs: 10 * 3600_000 },
      'claude',
      now,
      now,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].kind).toBe('weekly');
    expect(windows[0].label).toBe('Semanal');
  });
