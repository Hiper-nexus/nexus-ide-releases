// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DESIGN_CHARTER } from './design-charter';
import { clampDial, composeDesignCharter } from './design-profile';

/**
 * Perfil de design — o contrato central é a frugalidade: perfil neutro devolve
 * a carta byte a byte (nenhum custo de prompt), e só dials fora da banda
 * neutra ou uma direção explícita adicionam o bloco de perfil.
 */

describe('composeDesignCharter', () => {
  it('returns the untouched charter for the neutral profile', () => {
    expect(composeDesignCharter()).toBe(DESIGN_CHARTER);
    expect(
      composeDesignCharter({
        designDirection: 'auto',
        designVariance: 5,
        designMotion: 5,
        designDensity: 5,
      }),
    ).toBe(DESIGN_CHARTER);
  });

  it('treats the whole 4–7 band as neutral (no profile block)', () => {
    expect(
      composeDesignCharter({
        designVariance: 4,
        designMotion: 7,
        designDensity: 6,
      }),
    ).toBe(DESIGN_CHARTER);
  });

  it('appends the direction brief with the bans-always-win preamble', () => {
    const composed = composeDesignCharter({ designDirection: 'brutalist' });
    expect(composed.startsWith(DESIGN_CHARTER)).toBe(true);
    expect(composed).toContain('## Design profile (workspace setting)');
    expect(composed).toContain('absolute bans above always win');
    expect(composed).toContain('BRUTALIST');
  });

  it('emits one line per dial outside the neutral band, with its value', () => {
    const composed = composeDesignCharter({
      designVariance: 9,
      designMotion: 2,
      designDensity: 5,
    });
    expect(composed).toContain('Layout variance 9/10');
    expect(composed).toContain('Motion intensity 2/10');
    expect(composed).not.toContain('Visual density');
  });

  it('composes direction and dials together', () => {
    const composed = composeDesignCharter({
      designDirection: 'minimalist',
      designDensity: 1,
    });
    expect(composed).toContain('MINIMALIST');
    expect(composed).toContain('Visual density 1/10');
  });

  it('ignores unknown directions from stale settings', () => {
    expect(
      composeDesignCharter({
        designDirection: 'vaporwave' as never,
      }),
    ).toBe(DESIGN_CHARTER);
  });

  it('clamps out-of-range and non-numeric dials instead of failing', () => {
    expect(clampDial(0)).toBe(1);
    expect(clampDial(42)).toBe(10);
    expect(clampDial(7.4)).toBe(7);
    expect(clampDial(undefined)).toBe(5);
    expect(clampDial(Number.NaN)).toBe(5);
    // Fora da faixa vira banda extrema, não erro:
    expect(composeDesignCharter({ designMotion: 99 })).toContain(
      'Motion intensity 10/10',
    );
  });
});
