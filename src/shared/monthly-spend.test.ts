import { describe, expect, it } from 'vitest';
import {
  buildSpendRows,
  computeMonthlySpend,
  detectedSpendId,
  newSpendEntryId,
  parseUsdInput,
  recentApiEquivalentUsd,
  removeSpendEntry,
  toSpendEntry,
  upsertSpendEntry,
  type DetectedPlan,
} from './monthly-spend';
import {
  MAX_SPEND_ENTRY_USD,
  spendSettingsPatchSchema,
  spendSettingsSchema,
  type SpendEntry,
} from './settings-types';

const max20x: DetectedPlan = {
  key: 'claude:acc-1',
  provider: 'claude',
  accountLabel: 'Trabalho',
  planLabel: 'Claude Max 20×',
  monthlyUsd: 200,
};
const team: DetectedPlan = {
  key: 'claude:acc-2',
  provider: 'claude',
  accountLabel: 'Empresa',
  planLabel: 'Claude Team',
  monthlyUsd: null,
};
const plus: DetectedPlan = {
  key: 'codex',
  provider: 'codex',
  accountLabel: 'Codex',
  planLabel: 'ChatGPT Plus',
  monthlyUsd: 20,
};

describe('parseUsdInput', () => {
  it.each([
    ['20', 20],
    ['$20', 20],
    ['US$ 200', 200],
    ['20.5', 20.5],
    ['20,50', 20.5],
    ['1,200.00', 1200],
    ['1.200,50', 1200.5],
    ['1,200', 1200],
    ['0', 0],
    ['19.999', 20],
  ])('reads %s as %s', (raw, expected) => {
    expect(parseUsdInput(raw)).toBe(expected);
  });

  it.each(['', '  ', 'abc', '-5', '20$', '1e3', String(MAX_SPEND_ENTRY_USD + 1)])(
    'rejects %j',
    (raw) => {
      expect(parseUsdInput(raw)).toBeNull();
    },
  );
});

describe('buildSpendRows', () => {
  it('lists detected plans with list price until the operator saves a value', () => {
    const rows = buildSpendRows([], [max20x, team]);
    expect(rows.map((row) => [row.id, row.monthlyUsd, row.source])).toEqual([
      ['plan:claude:acc-1', 200, 'detected'],
      ['plan:claude:acc-2', null, 'detected'],
    ]);
    expect(rows[0].label).toBe('Claude Max 20× · Trabalho');
  });

  it('a saved value wins over the detected list price and keeps the detection', () => {
    const saved: SpendEntry[] = [
      { id: detectedSpendId(max20x.key), label: 'Max 20× (com imposto)', kind: 'subscription', provider: 'claude', monthlyUsd: 216.5, active: true },
    ];
    const [row] = buildSpendRows(saved, [max20x]);
    expect(row).toMatchObject({ monthlyUsd: 216.5, source: 'saved', label: 'Max 20× (com imposto)' });
    expect(row.detected?.planLabel).toBe('Claude Max 20×');
  });

  it('keeps saved rows whose account is gone, and puts API spend after subscriptions', () => {
    const saved: SpendEntry[] = [
      { id: 'custom-api', label: 'OpenRouter', kind: 'api', provider: '', monthlyUsd: 35, active: true },
      { id: 'plan:claude:removed', label: 'Claude Pro', kind: 'subscription', provider: 'claude', monthlyUsd: 20, active: true },
      { id: 'custom-cursor', label: 'Cursor Pro', kind: 'subscription', provider: 'cursor-agent', monthlyUsd: 20, active: true },
    ];
    const rows = buildSpendRows(saved, [plus]);
    expect(rows.map((row) => row.id)).toEqual([
      'plan:codex',
      'plan:claude:removed',
      'custom-cursor',
      'custom-api',
    ]);
  });

  it('ignores a duplicated detection of the same account', () => {
    expect(buildSpendRows([], [plus, plus])).toHaveLength(1);
  });
});

describe('computeMonthlySpend', () => {
  it('sums active subscriptions and API spend, and compares with the API estimate', () => {
    const saved: SpendEntry[] = [
      { id: 'custom-api', label: 'API Anthropic', kind: 'api', provider: 'claude', monthlyUsd: 12.25, active: true },
      { id: 'custom-paused', label: 'Cursor Pro', kind: 'subscription', provider: 'cursor-agent', monthlyUsd: 20, active: false },
    ];
    const rows = buildSpendRows(saved, [max20x, plus, team]);
    const summary = computeMonthlySpend(rows, 1_840.4);
    expect(summary).toEqual({
      subscriptionsUsd: 220,
      apiUsd: 12.25,
      totalUsd: 232.25,
      activeCount: 4,
      unpricedCount: 1,
      apiEquivalentUsd: 1_840.4,
      savingsUsd: 1_608.15,
    });
  });

  it('reports a negative saving honestly when the plans cost more than the API would', () => {
    const summary = computeMonthlySpend(buildSpendRows([], [max20x]), 35);
    expect(summary.savingsUsd).toBe(-165);
  });

  it('has no saving without an API reading', () => {
    expect(computeMonthlySpend(buildSpendRows([], [plus]), null)).toMatchObject({
      totalUsd: 20,
      apiEquivalentUsd: null,
      savingsUsd: null,
    });
  });
});

describe('spend entries', () => {
  it('turns a detected row into a saved entry with the operator value', () => {
    const [row] = buildSpendRows([], [team]);
    const entry = toSpendEntry(row, { monthlyUsd: 30 });
    expect(entry).toEqual({
      id: 'plan:claude:acc-2',
      label: 'Claude Team · Empresa',
      kind: 'subscription',
      provider: 'claude',
      monthlyUsd: 30,
      active: true,
    });
    expect(spendSettingsPatchSchema.parse({ entries: [entry] }).entries).toEqual([entry]);
  });

  it('upserts in place, removes, and mints unique ids', () => {
    const a: SpendEntry = { id: 'custom-a', label: 'A', kind: 'api', provider: '', monthlyUsd: 1, active: true };
    const b: SpendEntry = { ...a, id: 'custom-b', label: 'B' };
    const list = upsertSpendEntry([a, b], { ...a, monthlyUsd: 5 });
    expect(list.map((entry) => [entry.id, entry.monthlyUsd])).toEqual([['custom-a', 5], ['custom-b', 1]]);
    expect(upsertSpendEntry(list, { ...a, id: 'custom-c' }).map((entry) => entry.id)).toEqual(['custom-a', 'custom-b', 'custom-c']);
    expect(removeSpendEntry(list, 'custom-a').map((entry) => entry.id)).toEqual(['custom-b']);
    expect(newSpendEntryId([{ ...a, id: 'custom-a' }], 10)).toBe('custom-b');
  });

  it('reads stored settings tolerantly and refuses duplicated ids on write', () => {
    const good = { id: 'custom-a', label: 'A', kind: 'api', provider: '', monthlyUsd: 3, active: true };
    expect(
      spendSettingsSchema.parse({
        entries: [good, { ...good, label: 'dup' }, { id: '../x', label: 'bad', kind: 'api', monthlyUsd: 1 }, { ...good, id: 'custom-b', monthlyUsd: -1 }],
      }).entries,
    ).toEqual([good]);
    expect(spendSettingsSchema.parse({ entries: 'nope' }).entries).toEqual([]);
    expect(spendSettingsPatchSchema.safeParse({ entries: [good, good] }).success).toBe(false);
  });
});

describe('recentApiEquivalentUsd', () => {
  it('sums only the requested local days', () => {
    const history = [
      { day: '2026-09-15', usdEquivalent: 100 },
      { day: '2026-09-16', usdEquivalent: 12.345 },
      { day: '2026-10-15', usdEquivalent: 7.5 },
      { day: '2026-10-16', usdEquivalent: 999 },
    ];
    expect(recentApiEquivalentUsd(history, '2026-09-16', '2026-10-15')).toBe(19.85);
  });
});
