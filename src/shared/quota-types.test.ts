import { describe, expect, it } from 'vitest';
import {
  collapseSharedQuotaEntries,
  compareEntriesByConsumption,
  peakUsedRatio,
} from './quota-types';

describe('collapseSharedQuotaEntries (F-720)', () => {
  it('uma linha por cota: a primeira de cada grupo fica, na ordem recebida', () => {
    const rows = [
      { id: 'kimi' },
      { id: 'glm', quotaGroup: 'zai-key' },
      { id: 'codex' },
      { id: 'glm-flash', quotaGroup: 'zai-key' },
      { id: 'longcat', quotaGroup: 'other-key' },
    ];
    expect(collapseSharedQuotaEntries(rows).map((row) => row.id)).toEqual([
      'kimi',
      'glm',
      'codex',
      'longcat',
    ]);
  });

  it('linha sem leitura por chave (sem grupo) nunca é escondida', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c', quotaGroup: undefined }];
    expect(collapseSharedQuotaEntries(rows)).toEqual(rows);
  });
});

describe('peakUsedRatio', () => {
  it('returns the highest honest window and ignores null/NaN/out of range', () => {
    expect(
      peakUsedRatio([
        { usedRatio: 0.13 },
        { usedRatio: null },
        { usedRatio: 0.91 },
        { usedRatio: Number.NaN },
        { usedRatio: 1.4 },
      ]),
    ).toBe(0.91);
    expect(peakUsedRatio([{ usedRatio: null }])).toBeNull();
    expect(peakUsedRatio([{ usedRatio: 0 }])).toBe(0);
  });
});

describe('compareEntriesByConsumption', () => {
  const row = (
    id: string,
    ratio: number | null,
    active = false,
  ) => ({
    id,
    label: id,
    active,
    windows: [{ usedRatio: ratio }],
  });

  it('puts the hungriest known reading first and unknown last', () => {
    const ordered = [
      row('alpha-low', 0.05),
      row('unknown', null),
      row('zulu-high', 0.91),
      row('zero', 0),
    ].sort(compareEntriesByConsumption);
    expect(ordered.map((item) => item.id)).toEqual([
      'zulu-high',
      'alpha-low',
      'zero',
      'unknown',
    ]);
  });

  it('uses active as a tie-break among equal used%', () => {
    const ordered = [
      row('idle', 0.8, false),
      row('live', 0.8, true),
    ].sort(compareEntriesByConsumption);
    expect(ordered.map((item) => item.id)).toEqual(['live', 'idle']);
  });
});
