import { describe, expect, it } from 'vitest';
import {
  achievementMeter,
  activeOperatorQuests,
  listAchievementProgress,
  tierProgress,
  xpKindLabel,
} from './gamification-progress';

const baseSnapshot = {
  counters: {} as Record<string, number>,
  streakDays: 0,
  prestige: 0,
  branch: 'base' as const,
  achievements: [] as string[],
  powerLevel: 0,
};

describe('gamification progress', () => {
  it('labels XP kinds in PT for the feed', () => {
    expect(xpKindLabel('agent_turn')).toMatch(/agente/i);
    expect(xpKindLabel('mission_green')).toMatch(/verde/i);
  });

  it('meters achievements against counters', () => {
    expect(
      achievementMeter('centuriao', {
        counters: { handoff_success: 40 },
        streakDays: 0,
        prestige: 0,
        branch: 'base',
      }),
    ).toEqual({ current: 40, target: 100 });
  });

  it('builds achievement list with progress ratios', () => {
    const list = listAchievementProgress({
      ...baseSnapshot,
      counters: { mission_green: 1, agent_turn: 3 },
      achievements: ['primeira-missao-verde'],
    });
    const green = list.find((item) => item.id === 'primeira-missao-verde');
    expect(green?.unlocked).toBe(true);
    expect(green?.ratio).toBe(1);
    const firstMission = list.find((item) => item.id === 'primeira-missao');
    expect(firstMission?.current).toBe(1);
    expect(firstMission?.unlocked).toBe(false);
  });

  it('surfaces early quests when the profile is empty', () => {
    const quests = activeOperatorQuests(baseSnapshot);
    expect(quests.length).toBeGreaterThan(0);
    expect(quests.some((quest) => quest.id === 'quest-agent-turn')).toBe(true);
    expect(quests.every((quest) => quest.ratio < 1)).toBe(true);
  });

  it('computes remaining power and within-tier bar ratio', () => {
    const recruit = tierProgress({
      powerLevel: 25_000,
      nextTierAt: 100_000,
      tier: 'RECRUTA',
    });
    expect(recruit.remaining).toBe(75_000);
    expect(recruit.ratio).toBeCloseTo(0.25);

    // VETERANO starts at 400k; next 1.5M → bar near 0 just after crossing.
    const veteran = tierProgress({
      powerLevel: 400_000,
      nextTierAt: 1_500_000,
      tier: 'VETERANO',
    });
    expect(veteran.ratio).toBeCloseTo(0);
    expect(veteran.remaining).toBe(1_100_000);
  });
});
