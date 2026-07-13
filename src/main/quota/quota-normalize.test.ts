import { describe, expect, it } from 'vitest';
import {
  clampRatio,
  defaultUnknownWindows,
  exhaustedWindow,
  formatRemaining,
  knownWindow,
  mergeWindows,
  unknownWindow,
} from './quota-normalize';

describe('quota-normalize', () => {
  it('never treats unknown as zero', () => {
    const u = unknownWindow('weekly', 'Semanal');
    expect(u.usedRatio).toBeNull();
    expect(u.source).toBe('unknown');
  });

  it('clamps known ratios', () => {
    expect(knownWindow({
      kind: 'session',
      label: 'Sessão',
      usedRatio: 1.5,
      source: 'provider-api',
      confidence: 'high',
    }).usedRatio).toBe(1);
    expect(clampRatio(-2)).toBe(0);
  });

  it('exhausted windows are 100% with remaining label', () => {
    const now = 1_000_000;
    const w = exhaustedWindow({
      kind: 'hours',
      label: '5 Horas',
      resetsAt: now + 90 * 60_000,
      now,
    });
    expect(w.usedRatio).toBe(1);
    expect(w.remainingLabel).toMatch(/h|min/);
    expect(formatRemaining(now + 30 * 60_000, now)).toMatch(/min/);
  });

  it('merge keeps known over unknown', () => {
    const base = defaultUnknownWindows('claude');
    const overlay = [
      knownWindow({
        kind: 'weekly',
        label: 'Semanal',
        usedRatio: 0.54,
        source: 'transcript-inferred',
        confidence: 'medium',
      }),
    ];
    const m = mergeWindows(base, overlay);
    const weekly = m.find((w) => w.kind === 'weekly');
    expect(weekly?.usedRatio).toBe(0.54);
    const hours = m.find((w) => w.kind === 'hours');
    expect(hours?.usedRatio).toBeNull();
    expect(hours?.label).toBe('5 Horas');
  });

  it('fleet defaults are 5 Horas + Semanal for cloud LLMs', () => {
    for (const id of [
      'claude',
      'codex',
      'glm',
      'kimi',
      'agy',
      'longcat',
      'opencode',
      'aider',
    ]) {
      const w = defaultUnknownWindows(id);
      expect(w.map((x) => x.kind)).toEqual(['hours', 'weekly']);
      expect(w.map((x) => x.label)).toEqual(['5 Horas', 'Semanal']);
      expect(w.every((x) => x.usedRatio === null)).toBe(true);
    }
    // Grok CLI OAuth billing is monthly (not 5h/weekly SuperGrok chat).
    const grok = defaultUnknownWindows('grok');
    expect(grok.map((x) => x.kind)).toEqual(['hours', 'weekly', 'monthly']);
    expect(grok.find((x) => x.kind === 'monthly')?.label).toBe('Mensal');
  });
});
