import { describe, expect, it } from 'vitest';
import type { StoredXpEvent, XpEventInput } from '../../shared/gamification-types';
import { branchFor, computePoints, foldAggregate } from './xp-engine';
import { RULE_VERSION } from './xp-rules';

function input(over: Partial<XpEventInput> = {}): XpEventInput {
  return {
    kind: 'handoff_green',
    entityKey: 'handoff_green:h1',
    effort: 'medium',
    createdAt: 1_000,
    ...over,
  };
}

function stored(points: number, over: Partial<StoredXpEvent> = {}): StoredXpEvent {
  return { id: 1, points, ruleVersion: RULE_VERSION, ...input(), ...over };
}

describe('computePoints', () => {
  it('base × effort × diminishing; retro usa peso simples', () => {
    expect(computePoints(input(), 0)).toBe(8_000);
    expect(computePoints(input({ effort: 'high' }), 0)).toBe(14_400);
    expect(computePoints(input(), 5)).toBe(4_000);
    expect(computePoints(input({ kind: 'mission_green', retro: true }), 0)).toBe(10_000);
  });

  it('bônus de eficiência só em missão verde com custo na banda', () => {
    expect(computePoints(input({ kind: 'mission_green', costUsd: 0.3 }), 0)).toBe(37_500);
    expect(computePoints(input({ kind: 'mission_green', costUsd: 50 }), 0)).toBe(25_000);
  });

  it('pontos são inteiros e nunca negativos', () => {
    const p = computePoints(input({ effort: 'low' }), 10);
    expect(Number.isInteger(p)).toBe(true);
    expect(p).toBeGreaterThanOrEqual(0);
  });
});

describe('branchFor', () => {
  it('exige volume mínimo E dominância', () => {
    expect(branchFor({ deliveries_reviewer: 5 })).toBe('base');
    expect(branchFor({ deliveries_reviewer: 15, deliveries_executor: 10 })).toBe('guardiao');
    expect(
      branchFor({ deliveries_reviewer: 10, deliveries_executor: 10, deliveries_scout: 10 }),
    ).toBe('base');
    expect(branchFor({ deliveries_scout: 30, deliveries_executor: 5 })).toBe('scout');
    expect(branchFor({ deliveries_executor: 30, deliveries_reviewer: 5 })).toBe('forja');
  });
});

describe('foldAggregate', () => {
  it('soma power, deriva tier e counters por kind/categoria', () => {
    const events: StoredXpEvent[] = [
      stored(25_000, { kind: 'mission_green', entityKey: 'mission_green:m1' }),
      stored(80_000, { kind: 'mission_green', entityKey: 'mission_green:m2' }),
      stored(8_000, { agentCategory: 'reviewer' }),
    ];
    const agg = foldAggregate(events, 0);
    expect(agg.powerLevel).toBe(113_000);
    expect(agg.tier).toBe('INICIADO');
    expect(agg.nextTierAt).toBe(400_000);
    expect(agg.counters.mission_green).toBe(2);
    expect(agg.counters.deliveries_reviewer).toBe(1);
  });

  it('agregado vazio = RECRUTA zerado', () => {
    const agg = foldAggregate([], 0);
    expect(agg.powerLevel).toBe(0);
    expect(agg.tier).toBe('RECRUTA');
    expect(agg.branch).toBe('base');
  });
});
