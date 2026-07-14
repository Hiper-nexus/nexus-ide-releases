// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { humanElapsed } from './mission-glance';

describe('humanElapsed', () => {
  const now = 1_700_000_000_000;

  it('is empty for absent or future anchors', () => {
    expect(humanElapsed(null, now)).toBe('');
    expect(humanElapsed(0, now)).toBe('');
    expect(humanElapsed(now + 1_000, now)).toBe('');
  });

  it('formats seconds, minutes and hours in human PT', () => {
    expect(humanElapsed(now - 500, now)).toBe('há 1 s');
    expect(humanElapsed(now - 45_000, now)).toBe('há 45 s');
    expect(humanElapsed(now - 12 * 60_000, now)).toBe('há 12 min');
    expect(humanElapsed(now - 60 * 60_000, now)).toBe('há 1 h');
    expect(humanElapsed(now - (60 + 5) * 60_000, now)).toBe('há 1 h 05');
  });
});
