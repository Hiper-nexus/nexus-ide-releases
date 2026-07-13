import { describe, expect, it } from 'vitest';
import type { QuotaFleetSnapshot, ProviderQuotaEntry } from '../../shared/quota-types';
import {
  chipLabel,
  chipParts,
  chipTone,
  shortWindowsLine,
  windowDisplay,
} from './quota-display';

describe('quota-display', () => {
  it('shows em dash for unknown, never 0%', () => {
    const d = windowDisplay({
      kind: 'weekly',
      label: 'Semanal',
      usedRatio: null,
      source: 'unknown',
      confidence: 'low',
    });
    expect(d.percentLabel).toBe('—');
    expect(d.tone).toBe('unknown');
    expect(d.barRatio).toBe(0);
  });

  it('chip uses worst ratio and multi high-usage copy', () => {
    const snap: QuotaFleetSnapshot = {
      updatedAt: 1,
      entries: [{ id: 'a' } as ProviderQuotaEntry],
      worstUsedRatio: 0.54,
      highUsageCount: 1,
      unknownCount: 0,
    };
    expect(chipLabel(snap)).toBe('cota · 54%');
    expect(chipParts(snap)).toEqual({ value: '54%' });
    expect(chipTone(snap)).toBe('warn');

    snap.highUsageCount = 3;
    snap.worstUsedRatio = 0.9;
    expect(chipLabel(snap)).toMatch(/3 no limite/);
    expect(chipParts(snap)).toEqual({ value: '3 no limite' });
    expect(chipTone(snap)).toBe('danger');
  });

  it('chip for all-unknown fleet is not 0%', () => {
    const snap: QuotaFleetSnapshot = {
      updatedAt: 1,
      entries: [{ id: 'a' } as ProviderQuotaEntry],
      worstUsedRatio: null,
      highUsageCount: 0,
      unknownCount: 2,
    };
    expect(chipLabel(snap)).toBe('cota · —');
    expect(chipParts(snap)).toEqual({ value: '—' });
    expect(chipTone(snap)).toBe('unknown');
  });

  it('shortWindowsLine formats bars with em dash', () => {
    const entry: ProviderQuotaEntry = {
      id: 'claude',
      adapterId: 'claude',
      label: 'Claude',
      installed: true,
      onCooldown: false,
      updatedAt: 1,
      windows: [
        {
          kind: 'session',
          label: 'Sessão',
          usedRatio: null,
          source: 'unknown',
          confidence: 'low',
        },
        {
          kind: 'weekly',
          label: 'Semanal',
          usedRatio: 0.54,
          source: 'limit-hit',
          confidence: 'medium',
          remainingLabel: '1h36',
        },
      ],
    };
    const line = shortWindowsLine(entry);
    expect(line).toContain('—');
    expect(line).toContain('54%');
    expect(line).not.toMatch(/Sessão 0%/);
  });
});
