import { describe, expect, it } from 'vitest';
import {
  buildUsageAnalytics,
  clampUsageRange,
  localDayKey,
  shiftDayKey,
  summarizeUsage,
  usageDayStats,
  usageWindowStartDay,
} from './usage-analytics';
import type { UsageDayPoint, UsageRollupRow, UsageSessionActivity } from './usage-types';

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

/** Uma sessão por chamada; `cells` são pares [dia, modelo]. */
function session(provider: string, ...cells: [string, string][]): UsageSessionActivity {
  return { provider, cells };
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

describe('clampUsageRange', () => {
  it('keeps the picker inside the 90-day rollup and puts the ends in order', () => {
    expect(clampUsageRange('2026-10-15', '2026-10-01', '2026-10-10')).toEqual({ from: '2026-10-01', to: '2026-10-10' });
    expect(clampUsageRange('2026-10-15', '2026-01-01', '2026-12-31')).toEqual({ from: '2026-07-18', to: '2026-10-15' });
    expect(clampUsageRange('2026-10-15', '2026-10-12', '2026-10-03')).toEqual({ from: '2026-10-03', to: '2026-10-12' });
  });
});

describe('buildUsageAnalytics', () => {
  const today = '2026-10-15';

  it('keeps only the last 90 local days, oldest first, and drops sessions with no day left', () => {
    const analytics = buildUsageAnalytics(
      [
        row('2026-10-15', 'claude', 'opus'),
        row('2026-06-01', 'agy', 'gemini-3', { costUsd: 400 }),
        row('2026-10-16', 'claude', 'opus', { costUsd: 99 }),
        row('2026-08-01', 'agy', 'gemini-3'),
        row('2026-10-01', 'codex', 'gpt'),
      ],
      [
        session('agy', ['2026-06-01', 'gemini-3']),
        session('agy', ['2026-06-01', 'gemini-3'], ['2026-08-01', 'gemini-3']),
        session('claude', ['2026-10-15', 'opus'], ['2026-10-16', 'opus']),
      ],
      today,
    );
    expect(analytics.today).toBe(today);
    expect(analytics.rows.map((item) => item.day)).toEqual(['2026-08-01', '2026-10-01', '2026-10-15']);
    expect(analytics.sessions).toEqual([
      { provider: 'agy', cells: [['2026-08-01', 'gemini-3']] },
      { provider: 'claude', cells: [['2026-10-15', 'opus']] },
    ]);
  });
});

describe('summarizeUsage — presets', () => {
  const today = '2026-10-15';
  const analytics = buildUsageAnalytics(
    [
      row('2026-10-15', 'claude', 'claude-opus-5', { costUsd: 6 }),
      row('2026-10-15', 'codex', 'gpt-6-astra', { costUsd: 2 }),
      row('2026-10-01', 'codex', 'gpt-6-astra', { costUsd: 10 }),
      row('2026-08-01', 'agy', 'gemini-3', { costUsd: 4 }),
    ],
    [
      session('claude', ['2026-10-15', 'claude-opus-5']),
      session('codex', ['2026-10-15', 'gpt-6-astra']),
      session('codex', ['2026-10-01', 'gpt-6-astra']),
      session('agy', ['2026-08-01', 'gemini-3']),
      session('agy', ['2026-08-01', 'gemini-3']),
      session('agy', ['2026-08-01', 'gemini-3']),
    ],
    today,
  );
  const window = (days: number) =>
    summarizeUsage(analytics, { from: usageWindowStartDay(today, days), to: today });

  it('summarizes each window by provider, model, day and totals', () => {
    const week = window(7);
    expect(week.from).toBe('2026-10-09');
    expect(week.days.map((day) => day.day)).toEqual([
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ]);
    expect(week.byProvider.map((p) => [p.provider, p.costUsd, p.sessions, p.costShare])).toEqual([
      ['claude', 6, 1, 0.75],
      ['codex', 2, 1, 0.25],
    ]);
    expect(week.byProvider[0]).toMatchObject({
      totalTokens: 1_160,
      inputTokens: 110,
      cachedInputTokens: 1_000,
      outputTokens: 50,
      tokenShare: 0.5,
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
    const month = window(30);
    expect(month.byProvider.map((p) => p.provider)).toEqual(['codex', 'claude']);
    expect(month.byModel.map((m) => [m.model, m.costUsd])).toEqual([
      ['gpt-6-astra', 12],
      ['claude-opus-5', 6],
    ]);
    const quarter = window(90);
    expect(quarter.from).toBe('2026-07-18');
    expect(quarter.days).toHaveLength(90);
    expect(quarter.totals.costUsd).toBe(22);
    expect(quarter.totals.sessions).toBe(6);
  });

  it('never divides by zero on a range without cost or without any usage', () => {
    const free = buildUsageAnalytics([row(today, 'mimo-code', 'mimo', { costUsd: 0 })], [], today);
    const range = summarizeUsage(free, { from: today, to: today });
    expect(range.byProvider[0]).toMatchObject({ costShare: 0, sessions: 0 });
    expect(range.byProvider[0]!.tokenShare).toBe(1);
    const empty = summarizeUsage(analytics, { from: '2026-09-01', to: '2026-09-03' });
    expect(empty.byProvider).toEqual([]);
    expect(empty.byModel).toEqual([]);
    expect(empty.totals).toEqual({
      processedTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheSavingsUsd: 0,
      costUsd: 0,
      sessions: 0,
      turns: 0,
    });
    expect(empty.days.map((day) => [day.day, day.costUsd, day.totalTokens])).toEqual([
      ['2026-09-01', 0, 0],
      ['2026-09-02', 0, 0],
      ['2026-09-03', 0, 0],
    ]);
  });

  it('ignores non-finite and negative numbers instead of propagating NaN', () => {
    const dirty = buildUsageAnalytics(
      [row(today, 'claude', 'opus', { costUsd: Number.NaN, inputTokens: -5, outputTokens: Number.POSITIVE_INFINITY })],
      [],
      today,
    );
    const summary = summarizeUsage(dirty, { from: today, to: today });
    expect(summary.totals.costUsd).toBe(0);
    expect(summary.totals.processedTokens).toBe(1_000 + 10);
  });
});

describe('summarizeUsage — sessions are exact for any range, tool and model', () => {
  const today = '2026-10-15';
  const analytics = buildUsageAnalytics(
    [
      row('2026-10-14', 'claude', 'opus'),
      row('2026-10-15', 'claude', 'sonnet'),
      row('2026-10-15', 'codex', 'gpt'),
    ],
    [
      // Atravessa a meia-noite e troca de modelo.
      session('claude', ['2026-10-14', 'opus'], ['2026-10-15', 'sonnet']),
      session('codex', ['2026-10-15', 'gpt']),
    ],
    today,
  );
  const sessionsOf = (query: Parameters<typeof summarizeUsage>[1]) => summarizeUsage(analytics, query).totals.sessions;

  it('counts a session that crosses midnight once in the range and once on each single day', () => {
    expect(sessionsOf({ from: '2026-10-14', to: '2026-10-15' })).toBe(2);
    expect(sessionsOf({ from: '2026-10-14', to: '2026-10-14' })).toBe(1);
    expect(sessionsOf({ from: '2026-10-15', to: '2026-10-15' })).toBe(2);
    expect(sessionsOf({ from: '2026-10-13', to: '2026-10-13' })).toBe(0);
  });

  it('narrows by tool and by model without inventing sessions', () => {
    const all = { from: '2026-10-14', to: '2026-10-15' };
    expect(sessionsOf({ ...all, provider: 'claude' })).toBe(1);
    expect(sessionsOf({ ...all, provider: 'codex' })).toBe(1);
    expect(sessionsOf({ from: '2026-10-15', to: '2026-10-15', provider: 'claude', model: 'opus' })).toBe(0);
    expect(sessionsOf({ from: '2026-10-15', to: '2026-10-15', provider: 'claude', model: 'sonnet' })).toBe(1);
    // O nome do modelo sozinho (sem a ferramenta) não filtra nada.
    expect(sessionsOf({ ...all, model: 'sonnet' })).toBe(2);
  });
});

/** PRNG determinístico (LCG): o mesmo conjunto em qualquer máquina. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('summarizeUsage — every number on the page closes with the whole', () => {
  const today = '2026-10-15';
  const models: Record<string, string[]> = {
    claude: ['claude-opus-5-5', 'claude-sonnet-5-5'],
    codex: ['gpt-6-astra', 'gpt-6.1-sol'],
    'mimo-code': ['mimo-v2'],
  };
  const random = lcg(20_261_015);
  const rows: UsageRollupRow[] = [];
  const sessionPool = new Map<string, Map<string, Set<string>>>();
  for (let offset = 0; offset < 90; offset += 1) {
    const day = shiftDayKey(today, -offset);
    for (const [provider, providerModels] of Object.entries(models)) {
      for (const model of providerModels) {
        if (random() > 0.45) continue;
        // Múltiplos de 0,25: exatos em binário, então as somas fecham sem tolerância.
        rows.push(
          row(day, provider, model, {
            costUsd: Math.floor(random() * 400) * 0.25,
            inputTokens: Math.floor(random() * 5_000),
            cachedInputTokens: Math.floor(random() * 900_000),
            cacheWriteTokens: Math.floor(random() * 2_000),
            outputTokens: Math.floor(random() * 8_000),
            cacheSavingsUsd: Math.floor(random() * 80) * 0.25,
            turns: 1 + Math.floor(random() * 30),
          }),
        );
        const sessionId = `${provider}-${Math.floor(random() * 6)}`;
        const perProvider = sessionPool.get(provider) ?? new Map<string, Set<string>>();
        const cells = perProvider.get(sessionId) ?? new Set<string>();
        cells.add(`${day}\0${model}`);
        perProvider.set(sessionId, cells);
        sessionPool.set(provider, perProvider);
      }
    }
  }
  const sessions: UsageSessionActivity[] = [...sessionPool.entries()].flatMap(([provider, perProvider]) =>
    [...perProvider.values()].map((cells) => ({
      provider,
      cells: [...cells].map((cell) => cell.split('\0') as [string, string]),
    })),
  );
  const analytics = buildUsageAnalytics(rows, sessions, today);
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

  const ranges = [
    { name: '7 dias', from: usageWindowStartDay(today, 7), to: today },
    { name: '30 dias', from: usageWindowStartDay(today, 30), to: today },
    { name: '90 dias', from: usageWindowStartDay(today, 90), to: today },
    { name: 'intervalo', from: '2026-09-05', to: '2026-09-24' },
    { name: 'um dia', from: '2026-10-12', to: '2026-10-12' },
  ];
  const filters: { name: string; provider: string | null; model: string | null }[] = [
    { name: 'tudo', provider: null, model: null },
    ...Object.entries(models).flatMap(([provider, providerModels]) => [
      { name: provider, provider, model: null },
      ...providerModels.map((model) => ({ name: `${provider}/${model}`, provider, model })),
    ]),
  ];

  const cases = ranges.flatMap((range) =>
    filters.map((filter) => ({ range, filter, name: `${range.name} · ${filter.name}` })),
  );

  it.each(cases)('$name: gráfico, totais, ferramentas, modelos e sessões fecham', ({ range, filter }) => {
    const query = { from: range.from, to: range.to, provider: filter.provider, model: filter.model };
    const summary = summarizeUsage(analytics, query);
    const { totals } = summary;

    // Régua de dias: contínua, do início ao fim, com zero onde não houve uso.
    expect(summary.days[0]!.day).toBe(range.from);
    expect(summary.days.at(-1)!.day).toBe(range.to);
    summary.days.forEach((day, index) => expect(day.day).toBe(shiftDayKey(range.from, index)));

    // Gráfico == totais == lista por ferramenta == detalhamento por modelo.
    expect(sum(summary.days.map((day) => day.costUsd))).toBe(totals.costUsd);
    expect(sum(summary.days.map((day) => day.totalTokens))).toBe(totals.processedTokens);
    expect(sum(summary.byProvider.map((item) => item.costUsd))).toBe(totals.costUsd);
    expect(sum(summary.byProvider.map((item) => item.totalTokens))).toBe(totals.processedTokens);
    expect(sum(summary.byModel.map((item) => item.costUsd))).toBe(totals.costUsd);
    expect(sum(summary.byModel.map((item) => item.totalTokens))).toBe(totals.processedTokens);
    expect(totals.processedTokens).toBe(
      totals.cachedInputTokens + totals.uncachedInputTokens + totals.outputTokens,
    );
    expect(sum(summary.byProvider.map((item) => item.sessions))).toBe(totals.sessions);

    // Cada dia fecha com as fatias das ferramentas dele.
    for (const day of summary.days) {
      const slices = Object.values(day.byProvider);
      expect(sum(slices.map((slice) => slice.costUsd))).toBe(day.costUsd);
      expect(sum(slices.map((slice) => slice.totalTokens))).toBe(day.totalTokens);
    }

    // Participações fecham em 100% quando há o que repartir.
    if (totals.costUsd > 0) {
      expect(sum(summary.byProvider.map((item) => item.costShare))).toBeCloseTo(1, 9);
      expect(sum(summary.byModel.map((item) => item.costShare))).toBeCloseTo(1, 9);
    }
    if (totals.processedTokens > 0) {
      expect(sum(summary.byProvider.map((item) => item.tokenShare))).toBeCloseTo(1, 9);
      expect(sum(summary.byModel.map((item) => item.tokenShare))).toBeCloseTo(1, 9);
    }

    // O filtro é só um recorte do todo: bate com a linha do mesmo recorte sem filtro.
    const wide = summarizeUsage(analytics, { from: range.from, to: range.to });
    if (filter.provider !== null && filter.model === null) {
      const line = wide.byProvider.find((item) => item.provider === filter.provider);
      expect(totals.costUsd).toBe(line?.costUsd ?? 0);
      expect(totals.processedTokens).toBe(line?.totalTokens ?? 0);
      expect(totals.sessions).toBe(line?.sessions ?? 0);
    }
    if (filter.provider !== null && filter.model !== null) {
      const line = wide.byModel.find(
        (item) => item.provider === filter.provider && item.model === filter.model,
      );
      expect(totals.costUsd).toBe(line?.costUsd ?? 0);
      expect(totals.processedTokens).toBe(line?.totalTokens ?? 0);
    }

    // Escolher UM dia do intervalo dá o mesmo número que o ponto dele no gráfico.
    for (const day of summary.days) {
      const single = summarizeUsage(analytics, { ...query, from: day.day, to: day.day });
      expect(single.totals.costUsd).toBe(day.costUsd);
      expect(single.totals.processedTokens).toBe(day.totalTokens);
      expect(single.days).toHaveLength(1);
    }

    // Sessões: contagem de bruta força contra a lista de sessões da fixture.
    const expectedSessions = sessions.filter(
      (item) =>
        (filter.provider === null || item.provider === filter.provider) &&
        item.cells.some(
          ([day, model]) =>
            day >= range.from && day <= range.to && (filter.model === null || model === filter.model),
        ),
    ).length;
    expect(totals.sessions).toBe(expectedSessions);
  });

  it('sessions never add up across days: the whole range counts each session once', () => {
    const wide = summarizeUsage(analytics, { from: usageWindowStartDay(today, 90), to: today });
    const perDay = sum(
      wide.days.map((day) => summarizeUsage(analytics, { from: day.day, to: day.day }).totals.sessions),
    );
    expect(wide.totals.sessions).toBeLessThanOrEqual(sessions.length);
    expect(wide.totals.sessions).toBeLessThan(perDay);
  });
});

describe('usageDayStats', () => {
  const day = (name: string, costUsd: number, totalTokens: number): UsageDayPoint => ({
    day: name,
    costUsd,
    totalTokens,
    byProvider: {},
  });
  const days = [
    day('2026-10-10', 0, 0),
    day('2026-10-11', 10, 1_000),
    day('2026-10-12', 30, 500),
    day('2026-10-13', 0, 0),
    day('2026-10-14', 20, 3_000),
  ];

  it('totals, averages over days with use, and the peak of each measure', () => {
    const cost = usageDayStats(days, 'cost');
    expect(cost).toMatchObject({ dayCount: 5, activeDays: 3, costUsd: 60, totalTokens: 4_500 });
    expect(cost.averageCostUsd).toBe(20);
    expect(cost.averageTokens).toBe(1_500);
    expect(cost.peak?.day).toBe('2026-10-12');
    // O pico depende da medida: o dia mais caro não é o de mais tokens.
    expect(usageDayStats(days, 'tokens').peak?.day).toBe('2026-10-14');
  });

  it('has no peak and a zero average when nothing was used', () => {
    const stats = usageDayStats([day('2026-10-10', 0, 0), day('2026-10-11', 0, 0)], 'tokens');
    expect(stats).toMatchObject({ dayCount: 2, activeDays: 0, averageCostUsd: 0, averageTokens: 0, peak: null });
  });
});
