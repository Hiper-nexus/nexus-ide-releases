import { describe, expect, it } from 'vitest';
import {
  BASE_POINTS,
  diminishingFactor,
  efficiencyBonus,
  effortScale,
  nextTierAt,
  PRESTIGE_THRESHOLD,
  RULE_VERSION,
  TIER_THRESHOLDS,
  tierForPower,
} from './xp-rules';

describe('xp-rules', () => {
  it('pesos: entrega verde vale mais que simples; token NUNCA é fonte', () => {
    expect(BASE_POINTS.mission_green).toBeGreaterThan(BASE_POINTS.mission_done);
    expect(BASE_POINTS.handoff_green).toBeGreaterThan(BASE_POINTS.handoff_success);
    expect(Object.keys(BASE_POINTS)).not.toContain('token_spent');
    expect(RULE_VERSION).toBe(1);
  });

  it('effortScale: low < medium < high; desconhecido = neutro (1)', () => {
    expect(effortScale('low')).toBeLessThan(effortScale('medium'));
    expect(effortScale('medium')).toBeLessThan(effortScale('high'));
    expect(effortScale('medium')).toBe(1);
    expect(effortScale(undefined)).toBe(1);
    expect(effortScale('whatever')).toBe(1);
  });

  it('anti-farm: retorno decrescente por contagem no dia', () => {
    expect(diminishingFactor(0)).toBe(1);
    expect(diminishingFactor(4)).toBe(1);
    expect(diminishingFactor(5)).toBe(0.5);
    expect(diminishingFactor(9)).toBe(0.5);
    expect(diminishingFactor(10)).toBe(0.25);
    expect(diminishingFactor(50)).toBe(0.25);
  });

  it('eficiência: banda fixa por effort, só p/ missão verde, até +50%', () => {
    expect(efficiencyBonus('mission_green', 'medium', 0.3)).toBeCloseTo(0.5);
    expect(efficiencyBonus('mission_green', 'medium', 5)).toBe(0);
    expect(efficiencyBonus('mission_green', undefined, 0.3)).toBe(0);
    expect(efficiencyBonus('mission_green', 'medium', null)).toBe(0);
    expect(efficiencyBonus('handoff_green', 'medium', 0.01)).toBe(0);
  });

  it('tiers: escada exponencial RECRUTA→LENDA com piso em 0', () => {
    expect(TIER_THRESHOLDS[0]).toEqual({ tier: 'RECRUTA', minPower: 0 });
    expect(tierForPower(0)).toBe('RECRUTA');
    expect(tierForPower(100_000)).toBe('INICIADO');
    expect(tierForPower(25_000_000)).toBe('LENDA');
    for (let i = 2; i < TIER_THRESHOLDS.length; i += 1) {
      expect(TIER_THRESHOLDS[i].minPower).toBeGreaterThanOrEqual(
        TIER_THRESHOLDS[i - 1].minPower * 3,
      );
    }
  });

  it('nextTierAt aponta o próximo limiar; LENDA aponta prestígio', () => {
    expect(nextTierAt(0)).toBe(100_000);
    expect(nextTierAt(25_000_000)).toBe(PRESTIGE_THRESHOLD);
  });
});
