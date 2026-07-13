import { describe, expect, it } from 'vitest';
import {
  parseGrokTeamsUsage,
  windowsFromRateLimitHeaders,
} from './grok-usage';

describe('grok-usage', () => {
  it('builds session window from remaining/limit headers', () => {
    const w = windowsFromRateLimitHeaders({
      'x-ratelimit-remaining': '25',
      'x-ratelimit-limit': '100',
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      kind: 'hours',
      label: '5 Horas',
      usedRatio: 0.75,
      source: 'provider-api',
    });
  });

  it('returns empty without inventing when headers incomplete', () => {
    expect(windowsFromRateLimitHeaders({})).toEqual([]);
    expect(
      windowsFromRateLimitHeaders({ 'x-ratelimit-remaining': '10' }),
    ).toEqual([]);
  });

  it('parseGrokTeamsUsage stays empty without percent fields', () => {
    expect(
      parseGrokTeamsUsage({
        teams: [{ teamId: 'x', tier: 5 }],
      }),
    ).toEqual([]);
  });
});
