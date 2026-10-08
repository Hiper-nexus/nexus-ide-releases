import { describe, expect, it } from 'vitest';
import { buildUsageHistorySeries, localDayKey, niceCeiling } from './usage-history-chart';

const NOW = new Date(2026, 9, 8, 15).getTime();

describe('buildUsageHistorySeries', () => {
  it('régua contínua de 30 dias terminando hoje, com zero onde não houve uso', () => {
    const series = buildUsageHistorySeries(
      [
        { day: '2026-10-08', tokens: 1_000, usdEquivalent: 1.5, turns: 4 },
        { day: '2026-10-01', tokens: 500, usdEquivalent: 0.5, turns: 1 },
        { day: '2026-08-01', tokens: 9_999, usdEquivalent: 9, turns: 9 }, // fora da janela
      ],
      { now: NOW },
    );
    expect(series.points).toHaveLength(30);
    expect(series.points.at(-1)?.day).toBe('2026-10-08');
    expect(series.points[0]?.day).toBe('2026-09-09');
    expect(series.points.at(-1)?.shortLabel).toBe('08/10');
    expect(series.points.find((point) => point.day === '2026-10-02')?.tokens).toBe(0);
    expect(series.totals).toEqual({ tokens: 1_500, usdEquivalent: 2, turns: 5 });
    expect(series.activeDays).toBe(2);
  });

  it('dias antes de o histórico começar ficam marcados, não viram zero de uso', () => {
    const series = buildUsageHistorySeries([], {
      now: NOW,
      since: new Date(2026, 9, 6, 9).getTime(),
      span: 5,
    });
    expect(series.points.map((point) => [point.day, point.beforeTracking])).toEqual([
      ['2026-10-04', true],
      ['2026-10-05', true],
      ['2026-10-06', false],
      ['2026-10-07', false],
      ['2026-10-08', false],
    ]);
  });

  it('a chave do dia é a data local, igual ao main', () => {
    expect(localDayKey(new Date(2026, 0, 3, 23, 59).getTime())).toBe('2026-01-03');
  });
});

describe('niceCeiling', () => {
  it('arredonda para 1, 2 ou 5 × 10ⁿ acima do maior valor', () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(0.3)).toBe(0.5);
    expect(niceCeiling(7)).toBe(10);
    expect(niceCeiling(1_200)).toBe(2_000);
    expect(niceCeiling(4_100_000)).toBe(5_000_000);
  });
});
