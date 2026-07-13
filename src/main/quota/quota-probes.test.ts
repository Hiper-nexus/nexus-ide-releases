import { describe, expect, it } from 'vitest';
import { probeClaude, probeCodex, probeProviderWindows } from './quota-probes';

describe('quota-probes', () => {
  it('returns unknown ratios for claude without signals', () => {
    const w = probeClaude({});
    expect(w.every((x) => x.usedRatio === null || x.source !== 'unknown' || x.usedRatio === null)).toBe(true);
    expect(w.some((x) => x.usedRatio === null)).toBe(true);
    expect(w.find((x) => x.kind === 'weekly')?.usedRatio).toBeNull();
  });

  it('codex gets hours window label', () => {
    const w = probeCodex({});
    expect(w.some((x) => x.kind === 'hours')).toBe(true);
  });

  it('applies cooldown exhaustion without faking other windows to 0', () => {
    const now = 1_000_000;
    const w = probeProviderWindows({
      adapterId: 'claude',
      onCooldown: true,
      cooldownUntil: now + 3_600_000,
      now,
    });
    const hours = w.find((x) => x.kind === 'hours');
    expect(hours?.usedRatio).toBe(1);
    expect(hours?.source).toMatch(/cooldown|limit-hit/);
    const weekly = w.find((x) => x.kind === 'weekly');
    expect(weekly?.usedRatio).toBeNull();
  });

  it('ollama uses local-tokens source not fake weekly cloud %', () => {
    const w = probeProviderWindows({
      adapterId: 'ollama',
      localTokens: { inputTokens: 50_000, outputTokens: 10_000, costUsd: 0 },
    });
    const local = w.find((x) => x.kind === 'local');
    expect(local?.source).toBe('local-tokens');
    expect(local?.usedRatio).not.toBeNull();
    expect(local?.usedRatio).toBeGreaterThan(0);
    // Must not invent a cloud weekly percentage for ollama
    const weekly = w.find((x) => x.kind === 'weekly' && x.source === 'provider-api');
    expect(weekly).toBeUndefined();
  });

  it('limit-hit rate-limit on codex fills 5h bar', () => {
    const w = probeCodex({
      lastLimitHit: {
        kind: 'rate-limit',
        reason: 'usage limit',
        cooldownMs: 5 * 3600_000,
      },
      now: 0,
    });
    expect(w.find((x) => x.kind === 'hours')?.usedRatio).toBe(1);
  });
});
