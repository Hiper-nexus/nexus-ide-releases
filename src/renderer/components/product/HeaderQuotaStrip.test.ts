import { describe, expect, it } from 'vitest';
import type { ProviderQuotaEntry } from '../../../shared/quota-types';
import { headerQuotaItems } from './HeaderQuotaStrip';

const NOW = 1_000_000;

function entry(id: string, ratio: number | null, extra: Partial<ProviderQuotaEntry> = {}): ProviderQuotaEntry {
  return {
    id,
    adapterId: id,
    label: id,
    installed: true,
    onCooldown: false,
    windows: [
      {
        kind: 'weekly',
        label: 'Semanal',
        usedRatio: ratio,
        resetsAt: NOW + 4 * 3_600_000,
        source: 'provider-api',
        confidence: 'high',
      },
    ],
    ...extra,
  } as ProviderQuotaEntry;
}

describe('headerQuotaItems', () => {
  it('lista as mais gastas primeiro, com teto, e nunca inventa 0% sem leitura', () => {
    const items = headerQuotaItems(
      [entry('a', 0.2), entry('b', 0.9), entry('c', null), entry('d', 0.5)],
      NOW,
      2,
    );
    expect(items.map((item) => item.entry.id)).toEqual(['b', 'd']);
    expect(items[0]).toMatchObject({ tone: 'danger', reset: '4h' });
  });

  it('numera só provedor com várias contas, em ordem estável por id', () => {
    const items = headerQuotaItems(
      [
        entry('claude:b', 0.9, { adapterId: 'claude' }),
        entry('claude:a', 0.3, { adapterId: 'claude' }),
        entry('codex', 0.5, { adapterId: 'codex' }),
      ],
      NOW,
    );
    const suffix = Object.fromEntries(items.map((item) => [item.entry.id, item.suffix]));
    expect(suffix).toEqual({ 'claude:a': '1', 'claude:b': '2', codex: null });
  });

  it('ignora conta com credencial de outra identidade', () => {
    expect(headerQuotaItems([entry('x', 0.7, { readHint: 'identity-mismatch' })], NOW)).toEqual([]);
  });
});
