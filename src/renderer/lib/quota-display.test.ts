import { describe, expect, it } from 'vitest';
import type { QuotaFleetSnapshot, ProviderQuotaEntry } from '../../shared/quota-types';
import {
  prioritizeReportedQuotas,
  chipLabel,
  chipParts,
  chipTone,
  formatResetCountdown,
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

  it.each([[0.004, '0,4%'], [0.00001, '<0,1%'], [0.9999, '>99,9%'], [NaN, '—'], [Infinity, '—'], [1.2, '—']] as const)(
    'does not round a nonzero quota or invalid ratio into false certainty: %s', (usedRatio, label) => {
      expect(windowDisplay({ kind: 'weekly', label: 'Semanal', usedRatio, source: 'provider-api', confidence: 'high' }).percentLabel).toBe(label);
    },
  );

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
    expect(chipLabel(snap)).toMatch(/3 com uso elevado/);
    expect(chipParts(snap)).toEqual({ value: '3 com uso elevado' });
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

  it('shortWindowsLine recomputes the countdown from resetsAt instead of the frozen label', () => {
    const now = Date.parse('2026-09-14T12:00:00.000Z');
    const entry: ProviderQuotaEntry = {
      id: 'codex:ret',
      adapterId: 'codex',
      label: 'Codex · retornoja',
      installed: true,
      onCooldown: false,
      updatedAt: now,
      windows: [
        {
          kind: 'weekly',
          label: 'Semanal',
          usedRatio: 0.54,
          source: 'provider-api',
          confidence: 'high',
          resetsAt: now + 5 * 24 * 60 * 60_000 + 2 * 60 * 60_000,
          remainingLabel: '5d', // congelado no fetch — deve ser ignorado
        },
      ],
    };
    expect(shortWindowsLine(entry, now)).toBe('Semanal 54% · 5d2h');
  });

  it('formatResetCountdown formats minutes, hours and days in pt-BR', () => {
    const now = 1_000_000_000_000;
    expect(formatResetCountdown(undefined, now)).toBeNull();
    expect(formatResetCountdown(now - 10_000, now)).toBe('1min');
    expect(formatResetCountdown(now + 45 * 60_000, now)).toBe('45min');
    expect(formatResetCountdown(now + 90 * 60_000, now)).toBe('1h30m');
    expect(formatResetCountdown(now + 5 * 24 * 60 * 60_000, now)).toBe('5d');
    expect(formatResetCountdown(now + 5 * 24 * 60 * 60_000 + 3 * 60 * 60_000, now)).toBe('5d3h');
  });
});

  it('shortWindowsLine with compact option omits empty windows when reported data exists and abbreviates labels', () => {
    const now = Date.parse('2026-09-14T12:00:00.000Z');
    const entry: ProviderQuotaEntry = {
      id: 'glm',
      adapterId: 'glm',
      label: 'GLM',
      installed: true,
      onCooldown: false,
      updatedAt: now,
      windows: [
        {
          kind: 'hours',
          label: '5 Horas',
          usedRatio: null,
          source: 'unknown',
          confidence: 'low',
        },
        {
          kind: 'weekly',
          label: 'Semanal',
          usedRatio: 0.29,
          source: 'provider-api',
          confidence: 'high',
          resetsAt: now + 6 * 24 * 60 * 60_000 + 9 * 60 * 60_000,
        },
      ],
    };
    // In compact mode: ignores empty "5h —" and abbreviates "Semanal" -> "Sem"
    expect(shortWindowsLine(entry, now, { compact: true })).toBe('Sem 29% · 6d9h');
  });

  it('puts confirmed quotas including zero before unknown entries without mutating the fleet', () => {
    const entry = (id: string, ratio: number | null, active = false) =>
      ({ id, active, windows: [{ usedRatio: ratio }] }) as ProviderQuotaEntry;
    const entries = [
      entry('unknown', null),
      entry('zero', 0, false),
      entry('zero-active', 0, true),
      entry('invalid', NaN),
      entry('reported', 0.71),
    ];
    // Reported entries first; among reported entries, active accounts come first
    expect(prioritizeReportedQuotas(entries).map((item) => item.id)).toEqual([
      'zero-active',
      'zero',
      'reported',
      'unknown',
      'invalid',
    ]);
  });
