import { describe, expect, it } from 'vitest';
import { GAMIFICATION_COPY } from '../../shared/gamification-types';
import {
  ACHIEVEMENTS,
  evaluateAchievements,
  type AchievementCtx,
} from './achievements';

function ctx(over: Partial<AchievementCtx> = {}): AchievementCtx {
  return { counters: {}, streakDays: 0, prestige: 0, branch: 'base', ...over };
}

describe('achievements', () => {
  it('catálogo tem 12–15 conquistas, ids únicos e copy no shared', () => {
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(12);
    expect(ACHIEVEMENTS.length).toBeLessThanOrEqual(15);
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ACHIEVEMENTS) {
      const copy = GAMIFICATION_COPY.achievements[a.id];
      expect(copy?.title.length).toBeGreaterThan(0);
      expect(copy?.description.length).toBeGreaterThan(0);
    }
  });

  it('desbloqueia por marcos de counters e não re-desbloqueia', () => {
    const news = evaluateAchievements(ctx({ counters: { mission_green: 1 } }), new Set());
    expect(news.map((a) => a.id)).toContain('primeira-missao-verde');
    const again = evaluateAchievements(
      ctx({ counters: { mission_green: 5 } }),
      new Set(['primeira-missao-verde']),
    );
    expect(again.map((a) => a.id)).not.toContain('primeira-missao-verde');
  });

  it('centuriao exige 100 handoffs somados (green + success)', () => {
    const quase = ctx({ counters: { handoff_green: 60, handoff_success: 39 } });
    expect(evaluateAchievements(quase, new Set()).map((a) => a.id)).not.toContain('centuriao');
    const cem = ctx({ counters: { handoff_green: 60, handoff_success: 40 } });
    expect(evaluateAchievements(cem, new Set()).map((a) => a.id)).toContain('centuriao');
  });

  it('streak, prestígio e ramo destravam as suas', () => {
    expect(
      evaluateAchievements(ctx({ streakDays: 5 }), new Set()).map((a) => a.id),
    ).toContain('sequencia-5');
    expect(
      evaluateAchievements(ctx({ prestige: 1 }), new Set()).map((a) => a.id),
    ).toContain('transcendente');
    expect(
      evaluateAchievements(ctx({ branch: 'forja' }), new Set()).map((a) => a.id),
    ).toContain('evolucao');
  });

  it('pelo menos 4 conquistas concedem skin', () => {
    expect(ACHIEVEMENTS.filter((a) => a.skin).length).toBeGreaterThanOrEqual(4);
  });
});
