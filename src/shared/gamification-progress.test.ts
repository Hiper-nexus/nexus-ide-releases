import { describe, expect, it } from 'vitest';
import {
  achievementMeter,
  activeOperatorQuests,
  DAILY_XP_GOAL,
  listAchievementProgress,
  nextTierOf,
  nextTierPlan,
  pluralPt,
  recentAchievements,
  tierLevelOf,
  tierProgress,
  withGlobalXp,
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

  it('names the next tier instead of a vague milestone', () => {
    const veteran = tierProgress({
      powerLevel: 631_975,
      nextTierAt: 1_500_000,
      tier: 'VETERANO',
    });
    expect(veteran.nextTier).toBe('ELITE');
    expect(veteran.label).toBe('VETERANO → ELITE');
    const legend = tierProgress({
      powerLevel: 30_000_000,
      nextTierAt: 100_000_000,
      tier: 'LENDA',
    });
    expect(legend.nextTier).toBeNull();
  });

  it('translates the remaining XP into concrete deliveries', () => {
    expect(nextTierPlan(868_025)).toBe('≈ 290 handoffs aceitos ou 87 missões');
    expect(nextTierPlan(2_000)).toBe('≈ 1 handoff aceito ou 1 missão');
    expect(nextTierPlan(0)).toBeNull();
  });

  it('turns accepted handoffs into a visible milestone quest', () => {
    const quests = activeOperatorQuests({
      ...baseSnapshot,
      counters: {
        agent_turn: 6_581,
        jarvis_action: 4,
        mission_done: 8,
        handoff_success: 8,
      },
      streakDays: 2,
      todayXp: 17_225,
    });
    const handoffs = quests.find((quest) => quest.id === 'quest-handoffs');
    expect(handoffs).toEqual(
      expect.objectContaining({ current: 8, target: 10 }),
    );
    expect(handoffs?.hint).not.toMatch(/nexus-trusted/);
    expect(quests.some((quest) => quest.id === 'quest-green')).toBe(false);
    expect(quests.some((quest) => quest.id === 'quest-daily')).toBe(false);
  });

  it('offers the daily goal while today is below it', () => {
    const quests = activeOperatorQuests({
      ...baseSnapshot,
      counters: { agent_turn: 3 },
      todayXp: 900,
    });
    expect(quests[0]).toEqual(
      expect.objectContaining({
        id: 'quest-daily',
        current: 900,
        target: DAILY_XP_GOAL,
      }),
    );
  });

  it('lists the most recently unlocked achievements first', () => {
    expect(
      recentAchievements(
        ['primeiro-comando', 'primeira-missao', 'primeira-agentica'],
        2,
      ).map((item) => item.title),
    ).toEqual(['Arquiteto de Times', 'Primeiro Deploy']);
    expect(recentAchievements(['desconhecida'])).toEqual([]);
  });

  it('names the next tier and the 1-based level shown in the HUD', () => {
    expect(nextTierOf('RECRUTA')).toBe('INICIADO');
    expect(nextTierOf('MAESTRO')).toBe('LENDA');
    expect(nextTierOf('LENDA')).toBeNull();
    expect(tierLevelOf('RECRUTA')).toBe(1);
    expect(tierLevelOf('LENDA')).toBe(6);
    // Tier desconhecido (snapshot de build antigo) nunca vira nível 0 nem "próximo = RECRUTA".
    expect(tierLevelOf('FANTASMA' as never)).toBe(1);
    expect(nextTierOf('FANTASMA' as never)).toBeNull();
  });

  it('pluralizes pt-BR counters (1 dia útil / 2 dias úteis, 0 = plural)', () => {
    expect(pluralPt(1, 'dia útil seguido', 'dias úteis seguidos')).toBe(
      '1 dia útil seguido',
    );
    expect(pluralPt(0, 'escudo', 'escudos')).toBe('0 escudos');
    expect(pluralPt(2, 'escudo', 'escudos')).toBe('2 escudos');
  });
});

describe('withGlobalXp', () => {
  const base = { powerLevel: 6_886, tier: 'RECRUTA' as const, nextTierAt: 100_000, todayXp: 5 };
  it('sem global devolve o próprio snapshot', () => {
    expect(withGlobalXp(base)).toBe(base);
  });
  it('com global troca poder, patente, marco e hoje; preserva o resto', () => {
    const out = withGlobalXp({
      ...base,
      prestige: 2,
      global: { powerLevel: 120_000, tier: 'INICIADO' as const, nextTierAt: 400_000, todayXp: 90 },
    });
    expect(out).toMatchObject({
      powerLevel: 120_000,
      tier: 'INICIADO',
      nextTierAt: 400_000,
      todayXp: 90,
      prestige: 2,
    });
  });
});
