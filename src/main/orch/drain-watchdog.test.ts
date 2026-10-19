import { describe, expect, it } from 'vitest';
import type { DrainEvidence, HeadroomInput } from '../quota/account-headroom';
import { decideDrainSwap, DRAIN_SWAP_COOLDOWN_MS } from './drain-watchdog';

const NOW = 1_000_000;
const EV: DrainEvidence = {
  requireSource: 'provider-api',
  maxAgeMs: 600_000,
  now: NOW,
};

const win = (usedRatio: number | null, source = 'provider-api') => ({
  label: '5 Horas',
  kind: 'hours' as const,
  usedRatio,
  source: source as HeadroomInput['windows'][number]['source'],
});
const at = (usedRatio: number | null, source?: string): HeadroomInput => ({
  windows: [win(usedRatio, source)],
  updatedAt: NOW - 60_000,
});

const base = {
  hasPendingWork: true,
  lastSwapAt: null as number | null,
  evidence: EV,
};

describe('decideDrainSwap (camada 2)', () => {
  it('troca quando a conta esgotou e há trabalho pendente', () => {
    expect(decideDrainSwap({ ...base, headroom: at(1) }).swap).toBe(true);
  });

  it('NÃO troca pane sem trabalho pendente', () => {
    const d = decideDrainSwap({ ...base, headroom: at(1), hasPendingWork: false });
    expect(d.swap).toBe(false);
    expect(d.reason).toMatch(/sem trabalho pendente/);
  });

  it('não troca por drenagem: a camada 2 só atende esgotamento', () => {
    const d = decideDrainSwap({ ...base, headroom: at(0.95) });
    expect(d.swap).toBe(false);
    expect(d.reason).toMatch(/não esgotou/);
  });

  it('respeita o teto de uma troca por pane por hora', () => {
    const d = decideDrainSwap({
      ...base,
      headroom: at(1),
      lastSwapAt: NOW - (DRAIN_SWAP_COOLDOWN_MS - 1),
    });
    expect(d.swap).toBe(false);
    expect(d.reason).toMatch(/teto/);
  });

  it('passado o teto, troca de novo', () => {
    const d = decideDrainSwap({
      ...base,
      headroom: at(1),
      lastSwapAt: NOW - DRAIN_SWAP_COOLDOWN_MS,
    });
    expect(d.swap).toBe(true);
  });

  it('sem leitura nenhuma não troca', () => {
    const d = decideDrainSwap({ ...base, headroom: undefined });
    expect(d.swap).toBe(false);
    expect(d.reason).toMatch(/sem leitura/);
  });

  it('leitura que não é do provedor não troca', () => {
    expect(decideDrainSwap({ ...base, headroom: at(1, 'local-tokens') }).swap).toBe(false);
  });

  it('leitura velha não troca', () => {
    const stale: HeadroomInput = { windows: [win(1)], updatedAt: NOW - 600_001 };
    expect(decideDrainSwap({ ...base, headroom: stale }).swap).toBe(false);
  });

  it('usedRatio null não troca', () => {
    expect(decideDrainSwap({ ...base, headroom: at(null) }).swap).toBe(false);
  });
});
