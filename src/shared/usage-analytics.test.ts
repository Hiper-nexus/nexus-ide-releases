import { describe, expect, it } from 'vitest';
import {
  buildUsageAnalytics,
  fillUsageWindow,
  localDayKey,
  shiftDayKey,
  usageWindowStartDay,
  type UsageRollupRow,
} from './usage-analytics';

function row(day: string, provider: string, model: string, over: Partial<UsageRollupRow> = {}): UsageRollupRow {
  return {
    day,
    provider,
    model,
    costUsd: 1,
    inputTokens: 100,
    cachedInputTokens: 1_000,
    cacheWriteTokens: 10,
    outputTokens: 50,
    cacheSavingsUsd: 0.5,
    turns: 2,
    ...over,
  };
}

describe('day keys', () => {
  it('shifts calendar days across month and year boundaries', () => {
    expect(shiftDayKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDayKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(usageWindowStartDay('2026-10-15', 30)).toBe('2026-09-16');
    expect(usageWindowStartDay('2026-10-15', 7)).toBe('2026-10-09');
    expect(localDayKey(new Date(2026, 9, 15, 23, 59).getTime())).toBe('2026-10-15');
  });
});

describe('buildUsageAnalytics', () => {
  const today = '2026-10-15';
  const rows = [
    row('2026-10-15', 'claude', 'claude-opus-5', { costUsd: 6 }),
    row('2026-10-15', 'codex', 'gpt-6-astra', { costUsd: 2 }),
    row('2026-10-01', 'codex', 'gpt-6-astra', { costUsd: 10 }),
    row('2026-08-01', 'agy', 'gemini-3', { costUsd: 4 }),
    row('2026-06-01', 'agy', 'gemini-3', { costUsd: 400 }),
    row('2026-10-16', 'claude', 'claude-opus-5', { costUsd: 99 }),
  ];
  const sessions = [
    { provider: 'claude', sessions: { 7: 1, 30: 1, 90: 1 } },
    { provider: 'codex', sessions: { 7: 1, 30: 2, 90: 2 } },
    { provider: 'agy', sessions: { 7: 0, 30: 0, 90: 3 } },
  ] as const;
  const analytics = buildUsageAnalytics(rows, sessions, today);

  it('keeps only the last 90 local days, oldest first, per provider', () => {
    expect(analytics.days.map((day) => day.day)).toEqual(['2026-08-01', '2026-10-01', '2026-10-15']);
    const last = analytics.days.at(-1)!;
    expect(last.costUsd).toBe(8);
    expect(last.totalTokens).toBe(2 * 1_160);
    expect(last.byProvider).toEqual({
      claude: { costUsd: 6, totalTokens: 1_160 },
      codex: { costUsd: 2, totalTokens: 1_160 },
    });
  });

  it('summarizes each window by provider, model and totals', () => {
    const week = analytics.windows[7];
    expect(week.byProvider.map((p) => [p.provider, p.costUsd, p.sessions, p.costShare])).toEqual([
      ['claude', 6, 1, 0.75],
      ['codex', 2, 1, 0.25],
    ]);
    expect(week.byProvider[0]).toMatchObject({
      totalTokens: 1_160,
      inputTokens: 110,
      cachedInputTokens: 1_000,
      outputTokens: 50,
    });
    expect(week.totals).toEqual({
      processedTokens: 2_320,
      cachedInputTokens: 2_000,
      uncachedInputTokens: 220,
      outputTokens: 100,
      cacheSavingsUsd: 1,
      costUsd: 8,
      sessions: 2,
      turns: 4,
    });
    const month = analytics.windows[30];
    expect(month.byProvider.map((p) => p.provider)).toEqual(['codex', 'claude']);
    expect(month.byModel.map((m) => [m.model, m.costUsd])).toEqual([
      ['gpt-6-astra', 12],
      ['claude-opus-5', 6],
    ]);
    const quarter = analytics.windows[90];
    expect(quarter.startDay).toBe('2026-07-18');
    expect(quarter.totals.costUsd).toBe(22);
    expect(quarter.totals.sessions).toBe(6);
  });

  it('never divides by zero on a window without cost', () => {
    const free = buildUsageAnalytics([row(today, 'mimo-code', 'mimo', { costUsd: 0 })], [], today);
    expect(free.windows[7].byProvider[0]).toMatchObject({ costShare: 0, sessions: 0 });
  });
});

describe('fillUsageWindow', () => {
  it('returns one point per day with zeros for the gaps', () => {
    const filled = fillUsageWindow(
      [{ day: '2026-10-13', costUsd: 3, totalTokens: 30, byProvider: { claude: { costUsd: 3, totalTokens: 30 } } }],
      7,
      '2026-10-15',
    );
    expect(filled.map((point) => point.day)).toEqual([
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ]);
    expect(filled[4].costUsd).toBe(3);
    expect(filled[5]).toEqual({ day: '2026-10-14', costUsd: 0, totalTokens: 0, byProvider: {} });
  });
});
