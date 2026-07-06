/**
 * Conquistas v1 — avaliáveis a partir do agregado (counters/streak/prestígio/
 * ramo). Puro. Copy vive em GAMIFICATION_COPY.achievements (shared) para o
 * renderer não importar código do main. `skin` = paleta desbloqueada.
 */

export interface AchievementCtx {
  counters: Record<string, number>;
  streakDays: number;
  prestige: number;
  branch: string;
}

export interface AchievementDef {
  id: string;
  /** Skin (paleta) desbloqueada junto, quando houver. */
  skin?: string;
  test(ctx: AchievementCtx): boolean;
}

const c = (ctx: AchievementCtx, key: string) => ctx.counters[key] ?? 0;

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'primeira-missao', test: (x) => c(x, 'mission_done') + c(x, 'mission_green') >= 1 },
  { id: 'primeira-missao-verde', test: (x) => c(x, 'mission_green') >= 1 },
  { id: 'primeira-agentica', test: (x) => c(x, 'agentic_mission') >= 1 },
  { id: 'primeira-imagem', test: (x) => c(x, 'media_image') >= 1 },
  { id: 'primeiro-video', test: (x) => c(x, 'media_video') >= 1 },
  { id: 'primeiro-audio', test: (x) => c(x, 'media_audio') >= 1 },
  {
    id: 'centuriao',
    skin: 'centurion',
    test: (x) => c(x, 'handoff_green') + c(x, 'handoff_success') >= 100,
  },
  { id: 'economico', skin: 'gold', test: (x) => c(x, 'efficient_mission') >= 10 },
  { id: 'sequencia-5', test: (x) => x.streakDays >= 5 },
  { id: 'sequencia-20', skin: 'flame', test: (x) => x.streakDays >= 20 },
  { id: 'evolucao', test: (x) => x.branch !== 'base' },
  { id: 'maratona', test: (x) => c(x, 'mission_green') >= 50 },
  { id: 'transcendente', skin: 'prestige', test: (x) => x.prestige >= 1 },
];

export function evaluateAchievements(
  ctx: AchievementCtx,
  unlocked: Set<string>,
): AchievementDef[] {
  return ACHIEVEMENTS.filter((a) => !unlocked.has(a.id) && a.test(ctx));
}
